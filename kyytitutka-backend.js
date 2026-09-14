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
      const row = (t.timeTableRows || []).find(
        (r) => r.stationShortCode === TAMPERE_STATION && r.type === 'ARRIVAL'
      );
      if (!row) return null;
      const iso = row.liveEstimateTime || row.scheduledTime;
      return {
        type: 'juna',
        time: Math.floor(Date.parse(iso) / 1000),
        title: `${t.trainType}${t.trainNumber}`,
        detail: row.trainStopping === false ? 'Ei pysähdy' : 'Saapuu',
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

function busArrivalsFromRows(stopId, rows, now) {
  const result = [];
  const seen = new Set();
  for (const s of rows) {
    const trip = s.trip;
    if (!trip || s.realtimeState === 'CANCELED') continue;
    const stops = trip.pattern?.stops || [];
    const index = stops.findIndex((p) => p.gtfsId === stopId);
    if (index <= 0) continue; // -1: pysäkkiä ei löydy pattern-listalta. 0: tämä on lähtöpaikka, ei saapuminen.
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
      detail: `Lähtöpaikka: ${stops[0]?.name || 'ei tiedossa'}${s.realtime ? '' : ' (aikatauluaika)'}`,
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
  const batches = await Promise.all(
    candidates.map(async (stop) => busArrivalsFromRows(stop.gtfsId, await fetchStoptimesForStop(stop.gtfsId, now), now))
  );
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
// TÄMÄ ON ENSIMMÄINEN KOEYRITYS, EI VAHVISTETTU TOIMIVAKSI. En ole nähnyt Finavian
// tarkkaa rajapintadokumentaatiota, joten sekä URL-polku että tunnistautumisotsikko
// ovat parhaita arvauksia:
//   - URL: apiportal.finavia.fi näyttää Azure API Management -pohjaiselta, joten
//     kokeillaan tyypillistä rakennetta api.finavia.fi/flights/public/v0/flights/{asema}
//   - Otsikko: Azure APIM käyttää tyypillisesti nimeä "Ocp-Apim-Subscription-Key"
// Jos tämä epäonnistuu, HTTP-tila ja koko vastaus kirjataan lokiin sellaisenaan,
// samaan tapaan kuin bussipysäkkien ja tapahtumien kohdalla aiemmin - se kertoo
// suoraan mikä arvauksesta oli väärin.
//
// Tarkoituksella oma, erillinen funktio eikä osa OpenSky-hakua: nämä kaksi
// täydentävät toisiaan (Finavia = aikataulu etukäteen, OpenSky = fyysinen
// varmistus juuri ennen laskeutumista), eikä niitä ole vielä yhdistetty
// keskenään - sama lento voi siis näkyä listassa kahteen kertaan lähestyessään
// kenttää. Tämä voidaan siistiä myöhemmin kun nähdään miltä oikea data näyttää.
async function fetchFinaviaSchedule() {
  if (!process.env.FINAVIA_API_KEY) {
    console.error('Finavia ohitettu: FINAVIA_API_KEY puuttuu.');
    return [];
  }

  const url = 'https://api.finavia.fi/flights/public/v0/flights/TMP';
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

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    console.error('Finavia: vastaus ei ollut JSON:ia. Alku: ' + bodyText.slice(0, 300));
    return [];
  }

  const flights = Array.isArray(json) ? json : json.flights || json.data || json.results || [];
  console.error(`Finavia: löytyi ${flights.length} lentoa. Ensimmäinen: ` + JSON.stringify(flights[0] || {}).slice(0, 500));

  const now = Math.floor(Date.now() / 1000);
  return flights
    .map((f) => {
      const flightNumber = f.flightNumber || f.flight_number || f.flightId || f.iataFlightNumber || f.callSign;
      const origin = f.origin || f.departureAirport || f.depApName || f.from;
      const timeRaw = f.estimatedTime || f.scheduleTime || f.scheduledTime || f.eta;
      const time = timeRaw ? Math.floor(Date.parse(timeRaw) / 1000) : null;
      if (!flightNumber || !Number.isFinite(time)) return null;
      return {
        type: 'lento',
        time,
        title: flightNumber,
        detail: origin ? `Aikataulun mukaan saapuu, lähtöpaikka ${origin}` : 'Aikataulun mukaan saapuu',
        location: 'Lentoasema, Pirkkala',
        demand: 2,
      };
    })
    .filter(Boolean)
    .filter((f) => f.time > now - 300 && f.time < now + 86400 * 2);
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

  const combined = [...trains, ...buses, ...flightsAdsb, ...flightsSchedule, ...events].sort((a, b) => a.time - b.time);
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
