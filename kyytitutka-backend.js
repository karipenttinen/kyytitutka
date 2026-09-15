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
//
// HARKITTU JA HYLÄTTY (15.9.2026): Tays Päivystys Acutan ruuhkamittari
// (pirha.fi/palvelut/kiireellinen-hoito-ja-paivystys/paivystys/acutan-ruuhkamittari).
// Data on yllättävän rikasta (potilasmäärät osastoittain, ei vain liikennevalo),
// mutta kaksi estettä: (1) pirha.fi estää automaattisen haun robots.txt:llä,
// eikä erillistä/kolmannen osapuolen rajapintaa löytynyt taustalta, (2) vaikka
// tekninen reitti löytyisikin, data muuttuu tunnin sisällä eikä sovi
// events.json:n kaltaiseen kerran viikossa käsin päivitettävään malliin - se
// vaatisi saman 15 min automaation kuin junat/bussit/lennot. Ei toteutettu.

const fs = require('fs');
const path = require('path');

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
      edges { node { stop { gtfsId name lat lon } } }
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

function etaisyysMetreina(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

// Nyssen (Tampereen paikallisliikenteen) tunnettuja liikennöitsijänimiä
// GTFS-datassa. Suljetaan nämä aina pois riippumatta pysäkistä - varmuuden
// vuoksi tiukempi suoja sen lisäksi että etsimme nimenomaan kaukoliikenteen
// pysäkkejä. Täydennä listaa jos lokissa näkyy muitakin paikallisliikenteen
// nimiä jotka pääsevät läpi.
const TUNNETUT_PAIKALLISLIIKENTEEN_NIMET = ['nysse', 'tampereen kaupunki'];

function onPaikallisliikennetta(agencyName) {
  const n = String(agencyName || '').toLowerCase();
  return TUNNETUT_PAIKALLISLIIKENTEEN_NIMET.some((nimi) => n.includes(nimi));
}

function busArrivalsFromRows(stopId, rows, now) {
  const result = [];
  const seen = new Set();
  for (const s of rows) {
    const trip = s.trip;
    if (!trip || s.realtimeState === 'CANCELED') continue;
    if (onPaikallisliikennetta(trip.route?.agency?.name)) continue; // Nysse tms. paikallisliikenne, ei kaukoliikennettä
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
      _agency: trip.route?.agency?.name || '(tuntematon)',
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
          route { shortName longName agency { name gtfsId } }
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

  const terminaaliNimella = allStops.filter((s) => /linja-?autoasema/i.test(s.name || ''));
  const muutTunnetutKaukoliikenteenPysakit = allStops.filter((s) => /kuokkamaantie/i.test(s.name || ''));
  const nimellaLoytyneet = [...terminaaliNimella, ...muutTunnetutKaukoliikenteenPysakit];

  // Yleinen korjaus MATKA:358759-tyyppisiin tapauksiin: pelkällä numerolla
  // nimetyt pysäkit (kuten Helsinki-Vantaan V130-yhteyden laituri "2") eivät
  // täsmää nimihakuun mitenkään, joten otetaan lisäksi mukaan pysäkit jotka
  // ovat lähellä nimellä löytyneiden TERMINAALIN pysäkkien KESKIPISTETTÄ -
  // riippumatta niiden omasta nimestä. Keskipiste lasketaan tarkoituksella
  // vain terminaaliNimella-joukosta, ei Kuokkamaantiestä, koska se on n. 1,5 km
  // päässä ja vääristäisi keskipisteen pois oikealta paikalta. 200m osoittautui
  // liian avokätiseksi (nappasi mukaan "Sorin aukio" ja "Ratina", jotka ovat eri
  // paikkoja) - tiukennettu 90m:iin, ja lisäksi suljettu nimellä pois tunnetut
  // väärät osumat varmuuden vuoksi.
  const VARMASTI_MUU_PAIKKA = ['sorin aukio', 'ratina'];
  const kelvolliset = terminaaliNimella.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  let candidates = nimellaLoytyneet;
  if (kelvolliset.length > 0) {
    const keskiLat = kelvolliset.reduce((sum, s) => sum + s.lat, 0) / kelvolliset.length;
    const keskiLon = kelvolliset.reduce((sum, s) => sum + s.lon, 0) / kelvolliset.length;
    const muutLahella = allStops.filter((s) => {
      if (nimellaLoytyneet.some((n) => n.gtfsId === s.gtfsId)) return false;
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return false;
      if (VARMASTI_MUU_PAIKKA.some((p) => (s.name || '').toLowerCase().includes(p))) return false;
      return etaisyysMetreina(keskiLat, keskiLon, s.lat, s.lon) <= 90;
    });
    if (muutLahella.length > 0) {
      console.error(
        `Bussit: nimihaun lisäksi ${muutLahella.length} pysäkkiä 90m säteellä keskipisteestä (nimestä riippumatta): ` +
          muutLahella
            .map(
              (s) =>
                `${s.gtfsId} (${s.name}, ${Math.round(etaisyysMetreina(keskiLat, keskiLon, s.lat, s.lon))}m)`
            )
            .join(', ')
      );
    }
    candidates = [...nimellaLoytyneet, ...muutLahella];
  }

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

  const batches = rowsPerStop.map(({ stop, rows }) => busArrivalsFromRows(stop.gtfsId, rows, now));
  const kaikki = batches.flat().sort((a, b) => a.time - b.time);

  // Diagnostiikka: listataan kaikki mukaan päässeet liikennöitsijänimet, jotta
  // näemme onko Nysse-suodatus riittävä ja mikä agency-nimi esim. OnniBusilla
  // on - se auttaa myöhemmin sen kaikkien hajanaisten pysäkkien löytämisessä.
  const agencyt = [...new Set(kaikki.map((s) => s._agency))];
  console.error('Bussit: mukaan päässeet liikennöitsijät: ' + (agencyt.join(', ') || '(ei yhtään)'));

  return kaikki.map(({ _agency, ...rest }) => rest);
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

// ---------- 4. TAPAHTUMAT (käsin ylläpidetty events.json) ----------
// Kolme API-pohjaista lähdettä kokeiltu ja hylätty aiemmin:
//   - Tampereen LinkedEvents (linkedevents.tampere.fi) - rikki, ei vastaa
//     edes tavallisessa selaimessa
//   - VisitTampere.fi:n oma /api/v1/event - dokumentaatio vuodelta 2015,
//     korvattu 2022 sivustouudistuksessa, palauttaa HTML:ää JSON:in sijaan
//   - Visit Finland DataHub - ilmainen, ja rekisteröityminen onnistui, mutta
//     productAvailability-taulun startTime/endTime -kentät osoittautuivat
//     tyhjiksi (null) käytännössä kaikilla tuotteilla kokeiltaessa oikealla
//     avaimella (10 kohdennettua riviä, 0/10 kellonaikaa) - data on tasolla
//     "tuote auki päivämääristä X-Y", ei "tapahtuma alkaa kello 19", eikä siis
//     sovi kaukoliikenteen kaltaiseen täsmälliseen ajankohtaan
//   - api.visittampere.com:n oma "VisitTampere API" (Swagger, GET
//     /api/v1/eventztoday/event/all/) - tämä olisi rakenteeltaan sopinut,
//     mutta se on itse merkitty "Deprecated" ja poistui käytöstä 1.7.2026
//     (siis jo ennen tätä hetkeä). Saman datan voisi saada jatkossa vain
//     maksullisena Townbaselta (contactus@townbase.com) - sama tilanne kuin
//     FlightAwaren ja DataHubin kanssa: olemassa, mutta ei ilmainen.
//
// Sen sijaan tapahtumat luetaan tästä samassa kansiossa olevasta events.json-
// tiedostosta, joka päivitetään käsin (keskustelussa, aina kun tarpeen) -
// tapahtumat ovat luonteeltaan tiedossa hyvissä ajoin, joten tämä riittää
// hyvin eikä vaadi reaaliaikaista APIa.
//
// Tiedoston muoto, taulukko olioita:
//   [{ "title": "Ilves-Tappara", "start": "2026-09-20T18:30:00+03:00",
//      "end": "2026-09-20T21:00:00+03:00", "location": "Nokia Arena" }, ...]
// "end" on valinnainen. Jos annettu, käytetään sellaisenaan. Jos EI annettu,
// päättymisaika ARVIOIDAAN alkamisajasta + tyypillisestä kestosta (oletus
// 2,5h, tai "estimatedDurationHours" jos annettu per tapahtuma) ja merkitään
// selvästi "arvioiduksi" - kuljettajalle merkityksellisin hetki on juuri
// tapahtuman PÄÄTTYMINEN (silloin syntyy iso, kertaluonteinen kysyntäpiikki
// yleisön poistuessa), ei alkaminen, joten päättymisaika näytetään aina
// jollain tarkkuudella sen sijaan että jätettäisiin kokonaan pois.
const TAPAHTUMAN_OLETUSKESTO_TUNTIA = 2.5;

function helsinginKello(unixSec) {
  return new Intl.DateTimeFormat('fi-FI', {
    timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(unixSec * 1000));
}

// Jos tapahtuman päivä (Suomen aikaa) ei ole tämä päivä, näytetään pelkän
// kellonajan sijaan myös viikonpäivä eteen - muuten esim. huomisen "19.30"
// voi näyttää siltä kuin se olisi jo mennyt ohi tänä iltana.
function helsinginKelloPaivalla(unixSec, now) {
  const paivaFmt = { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'numeric', day: 'numeric' };
  const tanaan = new Intl.DateTimeFormat('fi-FI', paivaFmt).format(new Date(now * 1000));
  const tuo = new Intl.DateTimeFormat('fi-FI', paivaFmt).format(new Date(unixSec * 1000));
  const kello = helsinginKello(unixSec);
  if (tanaan === tuo) return kello;
  const viikonpaiva = new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', weekday: 'short' }).format(
    new Date(unixSec * 1000)
  );
  return `${viikonpaiva} ${kello}`;
}

function fetchEvents() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, 'events.json'), 'utf8');
  } catch (e) {
    console.error('Tapahtumat: events.json puuttuu tai ei voitu lukea - ohitetaan. (' + e.message + ')');
    return [];
  }

  let events;
  try {
    events = JSON.parse(raw);
  } catch (e) {
    console.error('Tapahtumat: events.json ei ole kelvollista JSONia - ohitetaan. (' + e.message + ')');
    return [];
  }
  if (!Array.isArray(events)) {
    console.error('Tapahtumat: events.json ei ole taulukko - ohitetaan.');
    return [];
  }

  const now = Math.floor(Date.now() / 1000);
  const tuoreusRaja = now + 86400 * 2; // sama 2 vrk -ikkuna kuin muillakin lähteillä
  const result = [];
  for (const ev of events) {
    if (!ev || !ev.title || !ev.start) continue;
    const startTime = Math.floor(Date.parse(ev.start) / 1000);
    if (!Number.isFinite(startTime)) continue;

    let endTime;
    let arvioitu;
    if (ev.end) {
      endTime = Math.floor(Date.parse(ev.end) / 1000);
      arvioitu = false;
    } else {
      const kesto = Number.isFinite(ev.estimatedDurationHours) ? ev.estimatedDurationHours : TAPAHTUMAN_OLETUSKESTO_TUNTIA;
      endTime = startTime + Math.round(kesto * 3600);
      arvioitu = true;
    }

    if (Number.isFinite(endTime) && endTime > now - 300 && endTime < tuoreusRaja) {
      result.push({
        type: 'tapahtuma',
        time: endTime,
        timeLabel: `${helsinginKelloPaivalla(startTime, now)}–${helsinginKelloPaivalla(endTime, now)}`,
        title: ev.title,
        detail: (arvioitu ? 'Arvioitu päättyvän' : 'Päättyy') + ', yleisöä poistumassa',
        location: ev.location || 'Tampere',
        demand: 2,
      });
    }
  }
  console.error(`Tapahtumat: events.json:sta luettu ${events.length} tapahtumaa, ${result.length} osuu 2 vrk ikkunaan.`);
  return result;
}

// ---------- ADS-B:N JA FINAVIAN YHDISTÄMINEN ----------
// Sama lento voi näkyä molemmissa lähteissä: OpenSkyn "title" on ICAO-tyylinen
// kutsumerkki (esim. "BTI357"), Finavian "fltnr" IATA-tyylinen (esim. "BT357") -
// eri etuliite, sama numero-osa. Vaihe 1: tunnistetaan sama lento numero-osan ja
// ajan läheisyyden (alle 20 min) perusteella - tämä on luotettavin tapa ja
// toimii esim. "BTI357" ↔ "BT357" -tapauksissa.
//
// Vaihe 2 (varasuodatin): jotkut kutsutunnukset eivät sisällä lainkaan samaa
// numeroa kuin lentonumero (havaittu esim. "BTI2MU" vastasi oikeasti BT526:ta,
// ei mitään numerollista yhteyttä kutsutunnuksessa). OpenSkyn ADS-B-data ei
// sisällä määränpäätietoa, joten tarkempaa ristiintarkistusta ei voi tehdä -
// ainoa jäljellä oleva signaali on ajallinen läheisyys (alle 10 min). Tämä
// yhdistetään VAIN jos ikkunassa on täsmälleen yksi vielä täsmäämätön
// aikataulurivi - jos ehdokkaita on useampia, ei voida olla varmoja kumpi on
// oikea, joten jätetään kaikki erillisiksi riveiksi sen sijaan että arvattaisiin
// väärin (väärä yhdistäminen piilottaisi oikean lennon kokonaan näkyvistä).
function extractDigits(str) {
  const m = String(str || '').match(/(\d+)/);
  return m ? m[1].replace(/^0+/, '') : null;
}

function mergeFlightSources(adsb, schedule) {
  const usedAdsbIndices = new Set();
  const usedScheduleIndices = new Set();
  const result = [];

  // Vaihe 1: tarkka numero+aika-täsmäys
  schedule.forEach((s, si) => {
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
      usedScheduleIndices.add(si);
      result.push({ ...s, detail: s.detail + ' · vahvistettu tutkalla juuri nyt' });
    }
  });

  // Vaihe 2: varasuodatin pelkällä ajalla (alle 10 min), vain jos yksiselitteinen
  adsb.forEach((a, ai) => {
    if (usedAdsbIndices.has(ai)) return;
    const ehdokkaat = schedule
      .map((s, si) => ({ s, si }))
      .filter(({ si }) => !usedScheduleIndices.has(si))
      .filter(({ s }) => Math.abs(a.time - s.time) < 600);
    if (ehdokkaat.length === 1) {
      const { s, si } = ehdokkaat[0];
      usedAdsbIndices.add(ai);
      usedScheduleIndices.add(si);
      result.push({ ...s, detail: s.detail + ' · vahvistettu tutkalla juuri nyt (aikaperusteinen täsmäys)' });
    }
  });

  schedule.forEach((s, si) => {
    if (!usedScheduleIndices.has(si)) result.push(s);
  });
  adsb.forEach((a, ai) => {
    if (!usedAdsbIndices.has(ai)) result.push(a);
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
