// Kyytitutka - taustapalvelun runko
// Hakee saapumistiedot aktiivisista lähteistä (junat, bussit, lennot kahdella
// tavalla) ja yhdistää ne yhdeksi feediksi, samassa muodossa kuin demon
// SIGNALS-taulukko (type, time, title, detail, location, demand). Tapahtumat
// on toistaiseksi tietoisesti pois käytöstä - ks. perustelut fetchEvents().
//
// YMPÄRISTÖMUUTTUJAT:
//   DIGITRANSIT_API_KEY   - Digitransitin API-portaalista (bussit)
//   OPENSKY_CLIENT_ID     - OpenSky-tililtä (lennot, ADS-B, fyysinen havainto)
//   OPENSKY_CLIENT_SECRET - OpenSky-tililtä
//   FINAVIA_API_KEY       - Finavian API-portaalista (lennot, aikataulutieto
//                           etukäteen) - KOKEELLINEN, ei vielä vahvistettu
//                           toimivaksi, ks. fetchFinaviaSchedule()
// Junadata ei vaadi avainta.
//
// TÄRKEÄÄ: kaikki diagnostiikka kirjoitetaan console.error:iin (stderr), EI
// console.log:iin - näin stdout sisältää PELKÄN JSON:in, kun ajetaan
// `node kyytitutka-backend.js > data.json`. Älä lisää console.log-kutsuja
// main()-funktion ulkopuolelle tuon yhden rivin lisäksi.
//
// Tilanne 14.9.2026: junat ja bussit vahvistettu toimiviksi oikealla datalla.
// Lennot palauttaa 0 havaintoa aina kun mikään kone ei satu olemaan juuri
// laskeutumassa sillä hetkellä kun Action ajetaan - tämä on odotettua, ei bugi.

const TAMPERE_STATION = 'TPE'; // Digitrafficin asemakoodi Tampereelle (vahvistettu)
const PIRKKALA_BBOX = { latMin: 61.40, latMax: 61.53, lonMin: 23.50, lonMax: 23.80 };

// Asemalyhenteiden käännökset kaupunkien nimiksi, Digitrafficin isokirjaiminen
// muoto (dokumentaatio antaa esimerkkeinä "HKL, TPE, PSL"). Lähde: yleisesti
// käytetty liikennepaikkojen lyhennelista. Kattaa kaukoliikenteen kannalta
// oleelliset, Tampereelta suoraan/vaihdotta liikennöitävät päätepisteet -
// laajenna listaa jos lokissa näkyy koodi joka puuttuu täältä.
const ASEMANIMET = {
  HKI: 'Helsinki', TKU: 'Turku', PRI: 'Pori', SK: 'Seinäjoki', VS: 'Vaasa',
  OL: 'Oulu', KOK: 'Kokkola', JNS: 'Joensuu', JY: 'Jyväskylä', KUO: 'Kuopio',
  ROI: 'Rovaniemi', KLI: 'Kolari', PKO: 'Parkano', RI: 'Riihimäki', TL: 'Toijala',
  KEM: 'Kemi', TOR: 'Tornio', MI: 'Mikkeli', LR: 'Lappeenranta', KV: 'Kouvola',
  LH: 'Lahti', IMR: 'Imatra', PM: 'Pieksämäki', VAR: 'Varkaus', NRM: 'Nurmes',
  LIS: 'Lieksa', SL: 'Savonlinna', TPE: 'Tampere',
};

function asemanNimi(koodi) {
  return ASEMANIMET[koodi] || koodi; // tuntematon koodi näytetään sellaisenaan arvaamisen sijaan
}

// ---------- 1. JUNAT (Digitraffic, ei avainta) ----------
async function fetchTrains() {
  const url = `https://rata.digitraffic.fi/api/v1/live-trains/station/${TAMPERE_STATION}` +
    `?arrived_trains=0&arriving_trains=20&departed_trains=0&departing_trains=0` +
    `&include_nonstopping=false&train_categories=Long-distance`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Digitraffic virhe: ${res.status}`);
  const trains = await res.json();

  return trains
    .map((t) => {
      const rows = t.timeTableRows || [];
      const row = rows.find((r) => r.stationShortCode === TAMPERE_STATION && r.type === 'ARRIVAL');
      if (!row) return null;
      const iso = row.liveEstimateTime || row.scheduledTime;
      const originCode = rows[0]?.stationShortCode;
      const destCode = rows[rows.length - 1]?.stationShortCode;
      const reitti = originCode && destCode ? `${asemanNimi(originCode)}–${asemanNimi(destCode)}` : null;
      return {
        type: 'juna',
        time: Math.floor(Date.parse(iso) / 1000),
        title: `${t.trainType}${t.trainNumber}`,
        detail: (row.trainStopping === false ? 'Ei pysähdy' : 'Saapuu') + (reitti ? ` · ${reitti}` : ''),
        location: `Rautatieasema${row.commercialTrack ? ' · raide ' + row.commercialTrack : ''}`,
        demand: 2,
      };
    })
    .filter(Boolean);
}

// ---------- 2. BUSSIT (Digitransit GraphQL, vaatii DIGITRANSIT_API_KEY) ----------
// Kiinteä pysäkkitunnus ("Matkahuolto:37958") ei toiminut - Digitransit palautti
// "ei löytynyt", vaikka sama tunnus on todistetusti Matkahuollon OMAN reittioppaan
// käyttämä viite. Nämä kaksi järjestelmää eivät siis jaa samaa numerointia.
//
// Sen sijaan että arvattaisiin lisää tunnuksia, tämä hakee pysäkit DYNAAMISESTI
// koordinaattien perusteella joka ajolla, ja kirjoittaa AINA lokiin (console.error)
// kaikki löytyneet pysäkit nimineen ja tunnuksineen - riippumatta siitä osuuko
// nimihaku "linja-autoasema" kohdalleen. Näin oikea tunnus näkyy suoraan Actionin
// lokista, eikä GraphiQL-selainta tarvita ollenkaan.

async function discoverNearbyStops() {
  const query = `{
    stopsByRadius(lat: 61.4980, lon: 23.7700, radius: 1000) {
      edges { node { stop { gtfsId name } } }
    }
  }`;
  const res = await fetch('https://api.digitransit.fi/routing/v2/finland/gtfs/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'digitransit-subscription-key': process.env.DIGITRANSIT_API_KEY,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Digitransit HTTP ${res.status} (pysäkkihaku)`);
  const json = await res.json();
  if (json.errors?.length) throw new Error('Digitransit (pysäkkihaku): ' + json.errors.map((e) => e.message).join('; '));

  const seen = new Set();
  const stops = [];
  for (const edge of json.data?.stopsByRadius?.edges || []) {
    const stop = edge.node.stop;
    if (stop?.gtfsId && !seen.has(stop.gtfsId)) {
      seen.add(stop.gtfsId);
      stops.push(stop);
    }
  }
  return stops;
}

// Tampereen lähikunnat, jotka suodatetaan pois bussihausta - näiden liikenne
// on seutuliikennettä, ei kaukoliikennettä, vaikka saapuisikin samalle
// linja-autoasemalle. Tämä on maantieteelliseen päättelyyn perustuva lista,
// ei mikään virallinen luokitus - täydennä tai muokkaa vapaasti tarpeen mukaan.
const TAMPEREEN_LAHIKUNNAT = ['orivesi', 'nokia', 'ylöjärvi', 'kangasala', 'lempäälä', 'pirkkala', 'vesilahti'];

function onLahiliikennetta(originName) {
  const n = String(originName || '').toLowerCase();
  return TAMPEREEN_LAHIKUNNAT.some((kunta) => n.includes(kunta));
}

function busArrivalsFromRows(stopId, rows, now) {
  const result = [];
  const seen = new Set();
  for (const s of rows) {
    const trip = s.trip;
    if (!trip || s.realtimeState === 'CANCELED') continue;
    const stops = trip.pattern?.stops || [];
    const index = stops.findIndex((p) => p.gtfsId === stopId);
    if (index <= 0) continue; // -1: pysäkkiä ei löydy pattern-listalta. 0: tämä on lähtöpaikka, ei saapuminen.
    const origin = stops[0]?.name || 'ei tiedossa';
    if (onLahiliikennetta(origin)) continue; // seutuliikennettä (esim. Orivesi), ei kaukoliikennettä
    const seconds = s.realtime && Number.isFinite(s.realtimeArrival) ? s.realtimeArrival : s.scheduledArrival;
    if (!Number.isFinite(s.serviceDay) || !Number.isFinite(seconds)) continue;
    const time = s.serviceDay + seconds;
    if (time < now - 300 || time > now + 86400) continue;
    const id = `${trip.gtfsId}:${s.serviceDay}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      type: 'bussi',
      time,
      title: trip.route?.shortName || trip.route?.longName || 'Bussi',
      detail: `Lähtöpaikka: ${origin}${s.realtime ? '' : ' (aikatauluaika)'}`,
      location: 'Linja-autoasema',
      demand: 1,
    });
  }
  return result;
}

async function fetchStoptimesForStop(stopId, now) {
  const query = `{
    stop(id: ${JSON.stringify(stopId)}) {
      stoptimesWithoutPatterns(numberOfDepartures: 100, startTime: ${now - 300}, timeRange: 86700) {
        scheduledArrival
        realtimeArrival
        realtime
        realtimeState
        serviceDay
        trip {
          gtfsId
          route { shortName longName }
          pattern { stops { gtfsId name } }
        }
      }
    }
  }`;
  const res = await fetch('https://api.digitransit.fi/routing/v2/finland/gtfs/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'digitransit-subscription-key': process.env.DIGITRANSIT_API_KEY,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Digitransit HTTP ${res.status} (${stopId})`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Digitransit (${stopId}): ` + json.errors.map((e) => e.message).join('; '));
  return json.data?.stop?.stoptimesWithoutPatterns || [];
}

async function fetchBuses() {
  if (!process.env.DIGITRANSIT_API_KEY) {
    console.error('Bussit ohitettu: DIGITRANSIT_API_KEY puuttuu.');
    return [];
  }

  const allStops = await discoverNearbyStops();
  console.error(`Bussit: löytyi ${allStops.length} pysäkkiä 1 km säteellä keskustasta:`);
  allStops.forEach((s) => console.error(`  ${s.gtfsId} :: ${s.name}`));

  const candidates = allStops.filter((s) => /linja-?autoasema/i.test(s.name || ''));
  if (candidates.length === 0) {
    console.error(
      'Bussit ohitettu: yksikään löytynyt pysäkki ei täsmännyt nimellä "linja-autoasema" - katso yllä oleva lista ja kerro mitä siinä lukee.'
    );
    return [];
  }
  console.error('Näistä käytetään: ' + candidates.map((s) => `${s.gtfsId} (${s.name})`).join(', '));

  const now = Math.floor(Date.now() / 1000);
  const rowsPerStop = await Promise.all(
    candidates.map(async (stop) => ({ stop, rows: await fetchStoptimesForStop(stop.gtfsId, now) }))
  );

  // Diagnostiikka: etsitään V130 (tai mikä tahansa Vantaa-yhteys) raakadatasta
  // ennen mitään suodatusta - näin nähdään putoaako se pois jo pysäkinvalinnassa
  // (ei löydy täältä ollenkaan) vai vasta saapumis-/lähikuntasuodatuksessa.
  let vantaaLoytyi = false;
  for (const { stop, rows } of rowsPerStop) {
    for (const r of rows) {
      const routeName = r.trip?.route?.shortName || r.trip?.route?.longName || '';
      const origin = r.trip?.pattern?.stops?.[0]?.name || '';
      if (/v130/i.test(routeName) || /vantaa/i.test(origin) || /vantaa/i.test(routeName)) {
        vantaaLoytyi = true;
        console.error(
          `Bussit: LÖYTYI V130/Vantaa-osuma pysäkillä ${stop.gtfsId} (${stop.name}): ` +
            `reitti="${routeName}", lähtöpaikka="${origin}", realtimeState=${r.realtimeState}`
        );
      }
    }
  }
  if (!vantaaLoytyi) {
    console.error('Bussit: ei yhtään V130- tai Vantaa-osumaa raakadatassa millään haetulla pysäkillä.');
  }

  // Diagnostiikka: näytetään KAIKKI raa'an datan saapumiset seuraavan 8 tunnin
  // sisällä millä tahansa reittitunnuksella, jotta nähdään onko siellä mitään
  // ylipäätään - riippumatta täsmääkö nimi tai lähikuntasuodatus. Ikkuna on
  // suhteessa nykyhetkeen (ei kiinteä kellonaika), jotta aikavyöhyke ei voi
  // mennä väärin GitHub Actionsin UTC-palvelimella - näyttöaika muunnetaan
  // Suomen aikaan vasta lopuksi Intl:n avulla.
  function helsinkiKello(unixSec) {
    return new Intl.DateTimeFormat('fi-FI', {
      timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(unixSec * 1000));
  }
  const kaikkiSaapumiset = [];
  for (const { stop, rows } of rowsPerStop) {
    for (const r of rows) {
      const t = r.serviceDay + (r.realtime && Number.isFinite(r.realtimeArrival) ? r.realtimeArrival : r.scheduledArrival);
      if (t >= now && t <= now + 8 * 3600) {
        kaikkiSaapumiset.push({
          t,
          routeName: r.trip?.route?.shortName || r.trip?.route?.longName || '(nimetön)',
          origin: r.trip?.pattern?.stops?.[0]?.name || '?',
          stopId: stop.gtfsId,
          tila: r.realtimeState,
        });
      }
    }
  }
  kaikkiSaapumiset.sort((a, b) => a.t - b.t);
  console.error(`Bussit: kaikki raa'an datan saapumiset seuraavan 8 tunnin sisällä (${kaikkiSaapumiset.length} kpl, Suomen aikaa):`);
  if (kaikkiSaapumiset.length === 0) {
    console.error('  (ei yhtään)');
  } else {
    kaikkiSaapumiset.forEach((s) => {
      console.error(`  ${helsinkiKello(s.t)} reitti="${s.routeName}" lähtö="${s.origin}" pysäkki=${s.stopId} tila=${s.tila}`);
    });
  }

  const batches = rowsPerStop.map(({ stop, rows }) => busArrivalsFromRows(stop.gtfsId, rows, now));
  return batches.flat().sort((a, b) => a.time - b.time);
}

// ---------- 3. LENNOT (OpenSky ADS-B, vaatii OPENSKY_CLIENT_ID/SECRET) ----------
// TARKISTA: token-endpoint on parhaan tietoni mukainen (OpenSky siirtyi OAuth2-
// kirjautumiseen 2026), mutta varmista tarkka osoite omalta tililtäsi ennen
// ensimmäistä ajoa - en pysty testaamaan tätä täältä.
async function getOpenSkyToken() {
  if (!process.env.OPENSKY_CLIENT_ID || !process.env.OPENSKY_CLIENT_SECRET) {
    throw new Error('OPENSKY_CLIENT_ID tai OPENSKY_CLIENT_SECRET puuttuu.');
  }
  const res = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.OPENSKY_CLIENT_ID,
        client_secret: process.env.OPENSKY_CLIENT_SECRET,
      }),
    }
  );
  if (!res.ok) throw new Error(`OpenSky-kirjautuminen epäonnistui: ${res.status}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('OpenSky ei palauttanut access_token-arvoa.');
  return json.access_token;
}

async function fetchFlights() {
  const token = await getOpenSkyToken();
  const { latMin, latMax, lonMin, lonMax } = PIRKKALA_BBOX;
  const url = `https://opensky-network.org/api/states/all?lamin=${latMin}&lomin=${lonMin}&lamax=${latMax}&lomax=${lonMax}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`OpenSky virhe: ${res.status}`);
  const json = await res.json();

  // Tilavektorin kentät (kiinteä järjestys): [1]=callsign [3]=time_position
  // [5]=longitude [6]=latitude [7]=baro_altitude [8]=on_ground
  return (json.states || [])
    .filter(
      (s) =>
        Number.isFinite(s[5]) &&
        Number.isFinite(s[6]) &&
        Number.isFinite(s[7]) &&
        s[7] < 900 &&
        s[8] === false &&
        Number.isFinite(s[3]) &&
        Date.now() / 1000 - s[3] <= 120
    )
    .map((s) => ({
      type: 'lento',
      time: s[3],
      title: (s[1] || '').trim() || s[0],
      detail: 'Matalalla ilmassa kentän lähellä (ADS-B; ei virallista saapumisaikaa)',
      location: 'Lentoasema, Pirkkala',
      demand: 2,
    }));
}

// ---------- 3b. LENNOT - AIKATAULUTIETO (Finavia, vaatii FINAVIA_API_KEY) ----------
// Polku ja otsikko VAHVISTETTU käyttäjän Finavia-portaalin Try It -konsolista:
// apigw.finavia.fi/flights/public/v0/flights, otsikko "app_key", https (http
// ei toimi GitHub Actionsista). Vastaus on XML, ei JSON - Node.js:ssä ei ole
// XML-jäsennintä valmiina, joten alla käytetään yksinkertaisia regexejä.
//
// Yhden lennon rakenne <arr tai dep><body><flight>...</flight></body></...> sisältä
// VAHVISTETTU suoraan käyttäjän lokista (arr-osiosta; dep oletetaan samanmuotoiseksi):
//   <h_apt>HEL</h_apt>          - kohdeasema (arr: minne saapuu / dep: mistä lähtee)
//   <fltnr>AY964</fltnr>        - lennon numero
//   <sdt>2026-09-14T06:15:00Z</sdt>  - aikataulun mukainen aika (ISO, UTC)
//   <route_1>CPH</route_1> / <route_n_1>Copenhagen</route_n_1> / <route_n_fi_1>Kööpenhamina</route_n_fi_1>
//                               - arr: lähtöpaikka / dep: määränpää (koodi / englanniksi / suomeksi)
//   <prt>Landed</prt> / <prt_f>Laskeutunut</prt_f>  - tila (englanniksi / suomeksi)
//
// PÄIVITYS: "apt=TMP"-parametri ei ilmeisesti suodata mitään, rajapinta palauttaa
// aina koko maan datan - ei haittaa, koska oma suodatus (airport === 'TMP') poimii
// oikeat rivit joka tapauksessa, vahvistettu toimivaksi ensimmäisellä ajolla.
//
// Tarkoituksella oma, erillinen funktio eikä osa OpenSky-hakua: nämä kaksi
// täydentävät toisiaan (Finavia = aikataulu etukäteen, OpenSky = fyysinen
// varmistus juuri ennen laskeutumista/nousua), eikä niitä ole vielä yhdistetty
// keskenään - sama lento voi siis näkyä listassa kahteen kertaan lähestyessään
// kenttää.
function xmlTag(block, name) {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1] : null;
}

function parseFlightSection(bodyText, sectionTag) {
  const match = bodyText.match(new RegExp(`<${sectionTag}>([\\s\\S]*?)</${sectionTag}>`));
  if (!match) return null;
  const blocks = [...match[1].matchAll(/<flight>([\s\S]*?)<\/flight>/g)].map((m) => m[1]);
  return blocks.map((block) => ({
    raw: block,
    airport: xmlTag(block, 'h_apt'),
    flightNumber: xmlTag(block, 'fltnr'),
    sdt: xmlTag(block, 'sdt'),
    estd: xmlTag(block, 'est_d'),
    actd: xmlTag(block, 'act_d'),
    place: xmlTag(block, 'route_n_fi_1') || xmlTag(block, 'route_n_1') || xmlTag(block, 'route_1'),
    status: xmlTag(block, 'prt_f') || xmlTag(block, 'prt'),
  }));
}

function finaviaToSignal(f, isDeparture, now) {
  // act_d (toteutunut) > est_d (arvioitu) > sdt (muuttumaton aikataulu) - näin
  // myöhästymiset/aikaistumiset näkyvät, sdt yksinään ei koskaan päivity.
  const bestIso = f.actd || f.estd || f.sdt;
  const time = bestIso ? Math.floor(Date.parse(bestIso) / 1000) : null;
  if (!f.flightNumber || !Number.isFinite(time)) return null;
  if (time <= now - 300 || time >= now + 86400 * 2) return null;

  let poikkeama = '';
  const sdtTime = f.sdt ? Math.floor(Date.parse(f.sdt) / 1000) : null;
  if (Number.isFinite(sdtTime) && Math.abs(time - sdtTime) >= 300) {
    const erotusMin = Math.round((time - sdtTime) / 60);
    poikkeama = erotusMin > 0 ? ` (myöhässä ${erotusMin} min)` : ` (${Math.abs(erotusMin)} min etuajassa)`;
  }

  const suunta = isDeparture
    ? f.place
      ? `Aikataulun mukaan lähtee, määränpää ${f.place}`
      : 'Aikataulun mukaan lähtee'
    : f.place
      ? `Aikataulun mukaan saapuu, lähtöpaikka ${f.place}`
      : 'Aikataulun mukaan saapuu';
  return {
    type: 'lento',
    time,
    title: f.flightNumber,
    detail: suunta + poikkeama + (f.status ? ` · ${f.status}` : ''),
    location: 'Lentoasema, Pirkkala',
    demand: 2,
  };
}

async function fetchFinaviaSchedule() {
  if (!process.env.FINAVIA_API_KEY) {
    console.error('Finavia ohitettu: FINAVIA_API_KEY puuttuu.');
    return [];
  }

  const url = 'https://apigw.finavia.fi/flights/public/v0/flights?apt=TMP';
  let res;
  try {
    res = await fetch(url, {
      headers: { app_key: process.env.FINAVIA_API_KEY },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    console.error('Finavia: verkkokutsu epäonnistui kokonaan: ' + e.message);
    return [];
  }

  const bodyText = await res.text();
  if (!res.ok) {
    console.error(`Finavia: HTTP ${res.status}. Vastaus: ${bodyText.slice(0, 600)}`);
    return [];
  }

  const arrRecords = parseFlightSection(bodyText, 'arr') || [];
  const depRecords = parseFlightSection(bodyText, 'dep') || [];
  if (!arrRecords.length && !depRecords.length) {
    console.error('Finavia: <arr>- eikä <dep>-osiota löytynyt. Alku: ' + bodyText.slice(0, 300));
    return [];
  }

  const arrAsemat = [...new Set(arrRecords.map((f) => f.airport))];
  const depAsemat = [...new Set(depRecords.map((f) => f.airport))];
  console.error(
    `Finavia: <arr> ${arrRecords.length} lentoa (asemat: ${arrAsemat.join(', ') || '-'}), ` +
      `<dep> ${depRecords.length} lentoa (asemat: ${depAsemat.join(', ') || '-'})`
  );

  const now = Math.floor(Date.now() / 1000);
  const saapuvat = arrRecords
    .filter((f) => f.airport === 'TMP')
    .map((f) => finaviaToSignal(f, false, now))
    .filter(Boolean);
  const lahtevat = depRecords
    .filter((f) => f.airport === 'TMP')
    .map((f) => finaviaToSignal(f, true, now))
    .filter(Boolean);

  return [...saapuvat, ...lahtevat];
}

// ---------- 4. TAPAHTUMAT ----------
// TOISTAISEKSI POIS KÄYTÖSTÄ (tietoinen päätös, ei bugi). Kolme lähdettä
// kokeiltu ja hylätty:
//   - Tampereen LinkedEvents (linkedevents.tampere.fi) - rikki, ei vastaa
//     edes tavallisessa selaimessa
//   - VisitTampere.fi:n oma /api/v1/event - dokumentaatio vuodelta 2015,
//     korvattu 2022 sivustouudistuksessa, palauttaa HTML:ää JSON:in sijaan
//   - Visit Finland DataHub - toimiva ja ajantasainen, mutta vaatii oman
//     rekisteröitymisen (developer.businessfinland.fi) ja on koko maan
//     matkailutuotetietokanta, ei pelkkä tapahtumalista - päätettiin että
//     tämä on liian raskas tähän tarpeeseen toistaiseksi
// Jos tähän halutaan palata myöhemmin, DataHub on tunnistettu oikea seuraava askel.
async function fetchEvents() {
  return [];
}

// ---------- ADS-B:N JA FINAVIAN YHDISTÄMINEN ----------
// Sama lento voi näkyä molemmissa lähteissä: OpenSkyn "title" on ICAO-tyylinen
// kutsumerkki (esim. "BTI357"), Finavian "fltnr" IATA-tyylinen (esim. "BT357") -
// eri etuliite, sama numero-osa. Tunnistetaan sama lento numero-osan ja ajan
// läheisyyden (alle 20 min) perusteella. Kun osuma löytyy, säilytetään
// Finavian rivi (enemmän tietoa: lähtöpaikka, tila) ja pudotetaan ADS-B-kaksoiskappale,
// merkiten että radar on vahvistanut sen. ADS-B-havainnot joille ei löydy paria
// (esim. yksityis-/rahtilennot, joita ei ole julkisessa aikataulussa) säilytetään sellaisenaan.
function extractDigits(str) {
  const m = String(str || '').match(/(\d+)/);
  return m ? m[1].replace(/^0+/, '') : null;
}

function mergeFlightSources(adsb, schedule) {
  const usedAdsbIndices = new Set();
  const result = [];

  for (const s of schedule) {
    const sDigits = extractDigits(s.title);
    const matchIndex = adsb.findIndex(
      (a, i) =>
        !usedAdsbIndices.has(i) &&
        sDigits &&
        extractDigits(a.title) === sDigits &&
        Math.abs(a.time - s.time) < 1200
    );
    if (matchIndex >= 0) {
      usedAdsbIndices.add(matchIndex);
      result.push({ ...s, detail: s.detail + ' · vahvistettu tutkalla juuri nyt' });
    } else {
      result.push(s);
    }
  }

  adsb.forEach((a, i) => {
    if (!usedAdsbIndices.has(i)) result.push(a);
  });

  return result;
}

// ---------- KOKOA KAIKKI YHTEEN ----------
async function main() {
  const results = await Promise.allSettled([
    fetchTrains(),
    fetchBuses(),
    fetchFlights(),
    fetchFinaviaSchedule(),
    fetchEvents(),
  ]);
  const [trains, buses, flightsAdsb, flightsSchedule, events] = results.map((r) =>
    r.status === 'fulfilled' ? r.value : []
  );
  const names = ['Junat', 'Bussit', 'Lennot (ADS-B)', 'Lennot (Finavia)', 'Tapahtumat'];

  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`${names[i]} epäonnistui:`, r.reason.message);
    else console.error(`${names[i]}: ${r.value.length} havaintoa`);
  });

  const flights = mergeFlightSources(flightsAdsb, flightsSchedule);
  console.error(
    `Lennot yhdistetty: ${flightsAdsb.length} ADS-B + ${flightsSchedule.length} Finavia -> ${flights.length} riviä (kaksoiskappaleet poistettu).`
  );

  const combined = [...trains, ...buses, ...flights, ...events].sort((a, b) => a.time - b.time);
  console.log(JSON.stringify(combined, null, 2));
  return combined;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { fetchTrains, fetchBuses, fetchFlights, fetchEvents, main };
