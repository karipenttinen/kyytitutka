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

// ---------- 2. BUSSIT (Digitransit GraphQL, vaatii DIGITRANSIT_API_KEY) ----------
// TARKISTA: tämä pysäkin GTFS-id pitää hakea itse Digitransitin GraphiQL-selaimesta,
// esim. kyselyllä `{ stopsByRadius(lat:61.4978, lon:23.7749, radius:300) { edges { node { stop { gtfsId name } } } } }`
// Tampereen linja-autoaseman koordinaateilla. En pysty hakemaan tätä itse tästä ympäristöstä.
const TAMPERE_BUS_STOP_ID = 'TARKISTA_GTFS_ID';

async function fetchBuses() {
  if (TAMPERE_BUS_STOP_ID === 'TARKISTA_GTFS_ID') {
    console.warn('Bussit ohitettu: TAMPERE_BUS_STOP_ID puuttuu vielä.');
    return [];
  }

  const query = `{
    stop(id: "${TAMPERE_BUS_STOP_ID}") {
      name
      stoptimesWithoutPatterns(numberOfDepartures: 20) {
        scheduledArrival
        realtimeArrival
        realtime
        serviceDay
        headsign
        trip { route { shortName longName } }
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
  });
  if (!res.ok) throw new Error(`Digitransit virhe: ${res.status}`);
  const json = await res.json();
  const stoptimes = json.data?.stop?.stoptimesWithoutPatterns || [];

  return stoptimes.map((s) => ({
    type: 'bussi',
    time: s.serviceDay + (s.realtime ? s.realtimeArrival : s.scheduledArrival),
    title: s.trip.route.shortName || s.trip.route.longName,
    detail: `Saapuu, määränpää ${s.headsign}`,
    location: 'Linja-autoasema',
    demand: 1,
  }));
}

// ---------- 3. LENNOT (OpenSky ADS-B, vaatii OPENSKY_CLIENT_ID/SECRET) ----------
// TARKISTA: alla oleva token-endpoint on parhaan tietoni mukainen (OpenSky siirtyi
// OAuth2-kirjautumiseen 2026), mutta tarkista tarkka osoite omalta tililtäsi/
// dokumentaatiosta ennen ensimmäistä ajoa - en pysty testaamaan tätä täältä.
async function getOpenSkyToken() {
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
    .filter((s) => s[6] !== null && s[7] !== null && s[7] < 900) // sijainti tiedossa + matala korkeus = lähestyy
    .map((s) => ({
      type: 'lento',
      time: s[4],
      title: (s[1] || '').trim() || s[0],
      detail: 'Lähestyy Tampere-Pirkkalaa (ADS-B, ei vielä virallista laskeutumisvahvistusta)',
      location: 'Lentoasema, Pirkkala',
      demand: 2,
    }));
}

// ---------- 4. TAPAHTUMAT (Tampereen LinkedEvents, ei avainta) ----------
async function fetchEvents() {
  const today = new Date().toISOString().split('T')[0];
  const url = `http://linkedevents.tampere.fi/v1/event/?start=${today}&end=${today}&sort=start_time`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`LinkedEvents virhe: ${res.status}`);
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
  console.log(JSON.stringify(combined, null, 2));
  return combined;
}

main();
