// Kyytitutka - taustapalvelun runko
// Hakee saapumistiedot neljästä lähteestä ja yhdistää ne yhdeksi feediksi,
// samassa muodossa kuin demon SIGNALS-taulukko (type, time, title, detail, location, demand).
//
// YMPÄRISTÖMUUTTUJAT (aseta nämä ennen ajoa):
//   DIGITRANSIT_API_KEY   - Digitransitin API-portaalista (bussit)
//   OPENSKY_CLIENT_ID     - OpenSky-tililtä (lennot/ADS-B)
//   OPENSKY_CLIENT_SECRET - OpenSky-tililtä
//
// Juna- ja tapahtumadata eivät vaadi avainta.
//
// HUOM koko tiedostosta: tätä ei ole voitu testata livenä, koska tässä
// ympäristössä ei ole verkkoyhteyttä. Endpointit ja kenttänimet on
// tarkistettu dokumentaatiosta/esimerkeistä, mutta kaksi kohtaa on
// merkitty erikseen "TARKISTA"-kommentilla - ne pitää varmistaa omalta
// tililtä/GraphiQL-selaimella ennen ensimmäistä ajoa.

const TAMPERE_STATION = 'TPE'; // Digitrafficin asemakoodi Tampereelle (vahvistettu)
const PIRKKALA_BBOX = { latMin: 61.40, latMax: 61.53, lonMin: 23.50, lonMax: 23.80 }; // väljä laatikko lentokentän ympärille

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

// ---------- 2. KAUKOLIIKENTEEN BUSSIT ----------
// Pysäkit vahvistettu käyttäjän 14.9.2026 Digitransit-hakulokista.
// Tunnuksen nimi "2" ei ole vahvistettu fyysisen lähtölaiturin numero.
const COACH_STOPS = ['MATKA:358759', 'VARELY:305869'];
// Lokissa tunnistetut kaukoliikenteen linjat. Kattavuus ei ole kaikki liikennöitsijät.
function isCoachRoute(route) {
  return route?.mode === 'BUS' && (
    (route.gtfsId?.startsWith('MATKA:') && /^(OB\d+|V130)$/.test(route.shortName || '')) ||
    ['VARELY:1401', 'VARELY:1411', 'VARELY:1412'].includes(route.gtfsId)
  );
}
function busSignals(stopId, rows, now = Math.floor(Date.now() / 1000)) {
  const result = [];
  const seen = new Set();
  for (const s of rows) {
    const trip = s.trip;
    if (!isCoachRoute(trip?.route) || s.realtimeState === 'CANCELED') continue;
    const stops = trip.pattern?.stops || [];
    const indices = stops.map((p, i) => p.gtfsId === stopId ? i : -1).filter(i => i >= 0);
    if (indices.length !== 1) throw new Error('Bussivuoron pysäkkijärjestystä ei voida tulkita yksiselitteisesti.');
    const index = indices[0];
    const add = (direction, scheduled, realtime, endpoint) => {
      const seconds = s.realtime && Number.isFinite(realtime) ? realtime : scheduled;
      if (!Number.isFinite(s.serviceDay) || !Number.isFinite(seconds)) return;
      const time = s.serviceDay + seconds;
      if (time < now - 300 || time > now + 86400) return;
      const id = `${trip.gtfsId}:${s.serviceDay}:${direction}:${index}`;
      if (seen.has(id)) return;
      seen.add(id);
      result.push({
        type: 'bussi', direction, time,
        title: `${trip.route.shortName || trip.route.longName} · ${direction === 'arrival' ? 'Saapuu' : 'Lähtee'}`,
        detail: `${direction === 'arrival' ? 'Lähtöpaikka' : 'Määränpää'}: ${endpoint || 'Ei tiedossa'} · ${s.realtime ? 'Reaaliaikatieto' : 'Aikatauluaika'}`,
        location: 'Tampereen linja-autoasema', demand: 1,
        route: trip.route.longName, tripId: trip.gtfsId, stopId,
        source: 'Digitransit',
      });
    };
    // Ensimmäisellä pysäkillä vain lähtö, viimeisellä vain saapuminen.
    // Läpi kulkevalle vuorolle molemmat omilla kellonajoillaan.
    if (index > 0) add('arrival', s.scheduledArrival, s.realtimeArrival, stops[0]?.name);
    if (index < stops.length - 1) add('departure', s.scheduledDeparture, s.realtimeDeparture, s.headsign || stops.at(-1)?.name);
  }
  return result;
}
async function fetchBuses() {
  if (!process.env.DIGITRANSIT_API_KEY) throw new Error('DIGITRANSIT_API_KEY puuttuu.');
  const now = Math.floor(Date.now() / 1000);
  const batches = await Promise.all(COACH_STOPS.map(async stopId => {
    const query = `{ stop(id: ${JSON.stringify(stopId)}) {
      stoptimesWithoutPatterns(numberOfDepartures: 500, startTime: ${now - 300}, timeRange: 86700, omitNonPickups: false) {
        scheduledArrival realtimeArrival scheduledDeparture realtimeDeparture
        realtime realtimeState serviceDay headsign
        trip { gtfsId route { gtfsId shortName longName mode }
          pattern { stops { gtfsId name } }
        }
      }
    } }`;
    const response = await fetch('https://api.digitransit.fi/routing/v2/finland/gtfs/v1', {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'digitransit-subscription-key': process.env.DIGITRANSIT_API_KEY },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Digitransit HTTP ${response.status}`);
    const data = await response.json();
    if (data.errors?.length) throw new Error('Digitransit: ' + data.errors.map(e => e.message).join('; '));
    if (!data.data?.stop) throw new Error(`Pysäkkiä ${stopId} ei löytynyt.`);
    const rows = data.data.stop.stoptimesWithoutPatterns || [];
    if (rows.length >= 500) throw new Error('Pysäkin hakuraja täyttyi; koko vuorokauden kattavuutta ei voi vahvistaa.');
    return busSignals(stopId, rows, now);
  }));
  const all = batches.flat().sort((a, b) => a.time - b.time);
  console.log(`Kaukobussit: ${all.filter(x => x.direction === 'arrival').length} saapumista ja ${all.filter(x => x.direction === 'departure').length} lähtöä.`);
  return all;
}

// ---------- 3. LENNOT (OpenSky ADS-B, vaatii OPENSKY_CLIENT_ID/SECRET) ----------
// TARKISTA: alla oleva token-endpoint on parhaan tietoni mukainen (OpenSky siirtyi
// OAuth2-kirjautumiseen 2026), mutta tarkista tarkka osoite omalta tililtäsi/
// dokumentaatiosta ennen ensimmäistä ajoa - en pysty testaamaan tätä täältä.
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

  // Tilavektorin kentät (kiinteä järjestys OpenSkyn dokumentaation mukaan):
  // [0]=icao24 [1]=callsign [4]=last_contact [6]=latitude [7]=baro_altitude
  return (json.states || [])
    .filter((s) => Number.isFinite(s[5]) && Number.isFinite(s[6]) &&
      Number.isFinite(s[7]) && s[7] < 900 && s[8] === false &&
      Number.isFinite(s[3]) && Date.now() / 1000 - s[3] <= 120) // tuore havainto ilmassa
    .map((s) => ({
      type: 'lento',
      time: s[3],
      title: (s[1] || '').trim() || s[0],
      detail: 'Matalalla havaittu lentokone kentän lähellä (ADS-B; määränpää ja saapumisaika eivät ole tiedossa)',
      location: 'Lentoasema, Pirkkala',
      demand: 2,
    }));
}

// ---------- 4. TAPAHTUMAT (Tampereen LinkedEvents, ei avainta) ----------
async function fetchEvents() {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki' }).format(new Date());
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const url = `https://linkedevents.tampere.fi/v1/event/?start=${today}&end=${tomorrow}&sort=start_time&include=location`;

  const res = await fetch(url);
  if (!res.ok) {
    let reason = '';
    try {
      const body = await res.json();
      reason = JSON.stringify(body.detail || body.message || body.error || '').slice(0, 300);
    } catch {}
    throw new Error(`LinkedEvents virhe: ${res.status} ${reason}`);
  }
  const json = await res.json();

  return (json.data || [])
    .filter((e) => e.name?.fi && e.end_time)
    .map((e) => ({
      type: 'tapahtuma',
      time: Math.floor(Date.parse(e.end_time) / 1000),
      title: e.name.fi,
      detail: 'Tapahtuma päättyy',
      location: e.location?.name?.fi || 'Tampere',
      demand: 2,
    }));
  // HUOM: tämä listaa KAIKKI tapahtumat - kannattaa myöhemmin suodattaa vain
  // isoimmat (esim. tunnettujen isojen paikkojen mukaan: Nokia-areena, Tampere-talo...),
  // koska rajapinta sisältää myös pienet harrastetapahtumat.
}

// ---------- KOKOA KAIKKI YHTEEN ----------
async function main() {
  const results = await Promise.allSettled([fetchTrains(), fetchBuses(), fetchFlights(), fetchEvents()]);
  const [trains, buses, flights, events] = results.map((r) => (r.status === 'fulfilled' ? r.value : []));

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(['Junat', 'Bussit', 'Lennot', 'Tapahtumat'][i], 'epäonnistui:', r.reason.message);
    }
  });

  const combined = [...trains, ...buses, ...flights, ...events].sort((a, b) => a.time - b.time);
  const names = ['Junat', 'Bussit', 'Lennot', 'Tapahtumat'];
  const sources = Object.fromEntries(results.map((r, i) => [names[i], {
    status: r.status === 'fulfilled' ? 'ok' : 'error',
    count: r.status === 'fulfilled' ? r.value.length : 0,
  }]));
  for (const [name, status] of Object.entries(sources)) {
    console.log(`${name}: ${status.status}, ${status.count} havaintoa`);
  }
  const fs = require('node:fs');
  const path = require('node:path');
  const output = process.env.OUTPUT_FILE || 'data/signals.json';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(combined, null, 2) + '\n');
  fs.writeFileSync(path.join(path.dirname(output), 'status.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), sources }, null, 2) + '\n');
  console.log(`Tallennettu: ${output}. GitHub Actions tarvitsee erillisen tallennus- tai julkaisuvaiheen säilyttääkseen tiedostot ajon jälkeen.`);
  console.log(JSON.stringify(combined, null, 2));
  if (results.some(r => r.status === 'rejected')) process.exitCode = 1;
  return combined;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { fetchTrains, fetchBuses, fetchFlights, fetchEvents, main, busSignals, isCoachRoute };
