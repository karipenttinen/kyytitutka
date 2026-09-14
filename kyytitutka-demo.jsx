import { useState, useEffect, useMemo } from 'react';
import { Plane, TrainFront, Bus, PartyPopper, MapPin } from 'lucide-react';

const NOW_BASE_MIN = 22 * 60 + 47; // simulated demo start: 22.47
const SIM_SPEED = 12; // sim-seconds that pass per real second

const SIGNALS = [
  { id: 'e1', type: 'tapahtuma', time: 1370, title: 'Tappara–Ässät päättyy', detail: 'Ottelu ohi, katsojat poistuvat', location: 'Nokia-areena', demand: 3 },
  { id: 'j1', type: 'juna', time: 1375, title: 'PYO 273', detail: 'Jatkaa Rovaniemelle', location: 'Rautatieasema · raide 1', demand: 2 },
  { id: 'k1', type: 'tapahtuma', time: 1400, title: 'Klubi-ilta päättyy', detail: 'Viimeiset vieraat poistuvat', location: 'Tullikamari', demand: 2 },
  { id: 'l1', type: 'lento', time: 1415, title: 'RY4211 Lontoo–Stansted', detail: 'Laskeutuu', location: 'Lentoasema, Pirkkala', demand: 2 },
  { id: 'j2', type: 'juna', time: 1430, title: 'PYO 266', detail: 'Jatkaa Helsinkiin', location: 'Rautatieasema · raide 1', demand: 2 },
  { id: 'j3', type: 'juna', time: 1595, title: 'PYO 274', detail: 'Jatkaa Helsinkiin', location: 'Rautatieasema · raide 3', demand: 2 },
  { id: 'j4', type: 'juna', time: 1670, title: 'IC 460', detail: 'Päättyy Tampereelle', location: 'Rautatieasema · raide 3', demand: 1 },
  { id: 'j5', type: 'juna', time: 1670, title: 'IC 80', detail: 'Jatkaa Helsinkiin', location: 'Rautatieasema · raide 5', demand: 1 },
  { id: 'j6', type: 'juna', time: 1673, title: 'IC 35', detail: 'Jatkaa Rovaniemelle', location: 'Rautatieasema · raide 2', demand: 1 },
  { id: 'j7', type: 'juna', time: 1674, title: 'IC 40', detail: 'Jatkaa Helsinkiin', location: 'Rautatieasema · raide 1', demand: 1 },
  { id: 'j8', type: 'juna', time: 1693, title: 'PYO 276', detail: 'Jatkaa Helsinkiin', location: 'Rautatieasema · raide 1', demand: 2 },
  { id: 'j9', type: 'juna', time: 1720, title: 'HDM 420', detail: 'Päättyy Tampereelle', location: 'Rautatieasema · raide 5', demand: 1 },
  { id: 'j10', type: 'juna', time: 1725, title: 'IC 462', detail: 'Päättyy Tampereelle', location: 'Rautatieasema · raide 3', demand: 1 },
  { id: 'j11', type: 'juna', time: 1729, title: 'IC 42', detail: 'Jatkaa Helsinkiin', location: 'Rautatieasema · raide 1', demand: 1 },
  { id: 'j12', type: 'juna', time: 1729, title: 'S 140', detail: 'Jatkaa Helsinkiin', location: 'Rautatieasema · raide 5', demand: 1 },
  { id: 'j13', type: 'juna', time: 1738, title: 'IC 21', detail: 'Jatkaa Ouluun', location: 'Rautatieasema · raide 2', demand: 2 },
  { id: 'l2', type: 'lento', time: 1810, title: 'RY1830 Berliini', detail: 'Laskeutuu', location: 'Lentoasema, Pirkkala', demand: 2 },
  { id: 'b1', type: 'bussi', time: 1830, title: 'Pikavuoro 5809', detail: 'Jyväskylästä', location: 'Linja-autoasema', demand: 1 },
  { id: 'b2', type: 'bussi', time: 1875, title: 'Vakiovuoro', detail: 'Porista', location: 'Linja-autoasema', demand: 1 },
  { id: 'l3', type: 'lento', time: 1900, title: 'FC901 Riika', detail: 'Laskeutuu', location: 'Lentoasema, Pirkkala', demand: 2 },
];

const TYPE_META = {
  lento: { icon: Plane, label: 'Lento' },
  juna: { icon: TrainFront, label: 'Juna' },
  bussi: { icon: Bus, label: 'Bussi' },
  tapahtuma: { icon: PartyPopper, label: 'Tapahtuma' },
};

const FILTERS = [
  { id: 'kaikki', label: 'Kaikki' },
  { id: 'lennot', label: 'Lennot' },
  { id: 'kaukoliikenne', label: 'Kaukoliikenne' },
  { id: 'tapahtumat', label: 'Tapahtumat' },
];

function matchesFilter(type, filterId) {
  if (filterId === 'kaikki') return true;
  if (filterId === 'lennot') return type === 'lento';
  if (filterId === 'kaukoliikenne') return type === 'juna' || type === 'bussi';
  if (filterId === 'tapahtumat') return type === 'tapahtuma';
  return true;
}

function formatClock(totalMinutes, seconds) {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}.${pad(mm)}.${pad(seconds)}`;
}

function formatTime(totalMinutes) {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}.${pad(mm)}`;
}

function getBand(delta) {
  if (delta <= -8) return null;
  if (delta <= 5) return 'nyt';
  if (delta <= 25) return 'pian';
  if (delta <= 75) return 'tunti';
  return 'myohemmin';
}

const BAND_ORDER = ['nyt', 'pian', 'tunti', 'myohemmin'];
const BAND_LABEL = {
  nyt: 'Saapuu juuri nyt',
  pian: 'Saapuu pian',
  tunti: 'Seuraavan tunnin aikana',
  myohemmin: 'Myöhemmin yön aikana',
};
const BAND_COLOR = {
  nyt: '#E8A94D',
  pian: '#E8A94D',
  tunti: '#9CA2B4',
  myohemmin: '#6B7286',
};

function DemandBars({ level }) {
  return (
    <div className="flex items-center gap-0.5" aria-label={`Kysyntä ${level}/3`}>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="w-1 rounded-full"
          style={{ height: 4 + i * 2, background: i <= level ? '#E8A94D' : '#252A38' }}
        />
      ))}
    </div>
  );
}

function Row({ signal }) {
  const meta = TYPE_META[signal.type];
  const Icon = meta.icon;
  const soon = signal.delta <= 5;
  return (
    <div
      className="flex items-start gap-3 py-3 px-4 border-b"
      style={{ borderColor: '#20242F', background: soon ? 'rgba(232,169,77,0.06)' : 'transparent' }}
    >
      <div className="pt-0.5" style={{ color: soon ? '#E8A94D' : '#6B7286', fontFamily: "'JetBrains Mono', monospace", fontSize: 13, minWidth: 46 }}>
        {formatTime(signal.time)}
      </div>
      <div className="pt-0.5" style={{ color: soon ? '#E8A94D' : '#6B7286' }}>
        <Icon size={16} strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <span style={{ color: '#EDEFF3', fontWeight: 600, fontSize: 14.5 }}>{signal.title}</span>
        <div style={{ color: '#8A90A3', fontSize: 13, marginTop: 1 }}>{signal.detail}</div>
        <div className="flex items-center gap-1 mt-1" style={{ color: '#5C6272', fontSize: 12 }}>
          <MapPin size={11} />
          <span>{signal.location}</span>
        </div>
      </div>
      <div className="pt-1">
        <DemandBars level={signal.demand} />
      </div>
    </div>
  );
}

export default function KyytitutkaDemo() {
  const [simSeconds, setSimSeconds] = useState(0);
  const [filter, setFilter] = useState('kaikki');

  useEffect(() => {
    const iv = setInterval(() => setSimSeconds((s) => s + SIM_SPEED / 4), 250);
    return () => clearInterval(iv);
  }, []);

  const nowTotalSeconds = NOW_BASE_MIN * 60 + simSeconds;
  const nowMinutes = Math.floor(nowTotalSeconds / 60);
  const clockSeconds = Math.floor(nowTotalSeconds % 60);

  const withDelta = useMemo(() => {
    return SIGNALS.map((s) => ({ ...s, delta: s.time - nowMinutes })).filter((s) => getBand(s.delta) !== null);
  }, [nowMinutes]);

  const filtered = withDelta.filter((s) => matchesFilter(s.type, filter));
  const sorted = [...filtered].sort((a, b) => a.delta - b.delta);
  const hero = sorted[0];
  const rest = hero ? sorted.slice(1) : [];

  const grouped = BAND_ORDER.map((band) => ({ band, items: rest.filter((s) => getBand(s.delta) === band) })).filter(
    (g) => g.items.length > 0
  );

  const upcomingHourCount = withDelta.filter((s) => s.delta <= 75).length;

  return (
    <div style={{ minHeight: '100vh', width: '100%', background: '#0D1017' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
        * { font-family: 'Manrope', sans-serif; box-sizing: border-box; }
        @media (prefers-reduced-motion: no-preference) {
          .kt-sweep { animation: kt-spin 4s linear infinite; }
        }
        @keyframes kt-spin { to { transform: rotate(360deg); } }
        .kt-tab { transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease; }
      `}</style>

      <div style={{ maxWidth: 480, margin: '0 auto', paddingBottom: 40 }}>
        <div style={{ padding: '20px 16px 12px' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div style={{ position: 'relative', width: 34, height: 34, flexShrink: 0 }}>
                <div style={{ position: 'absolute', inset: 0, borderRadius: 9999, border: '1px solid rgba(232,169,77,0.4)' }} />
                <div style={{ position: 'absolute', inset: 5, borderRadius: 9999, border: '1px solid rgba(232,169,77,0.25)' }} />
                <div className="kt-sweep" style={{ position: 'absolute', inset: 0, borderRadius: 9999, overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, background: 'conic-gradient(from 0deg, rgba(232,169,77,0.7), transparent 30%)' }} />
                </div>
                <div style={{ position: 'absolute', top: '50%', left: '50%', width: 5, height: 5, marginLeft: -2.5, marginTop: -2.5, borderRadius: 9999, background: '#E8A94D' }} />
              </div>
              <div>
                <div style={{ color: '#EDEFF3', fontWeight: 800, fontSize: 18 }}>Kyytitutka</div>
                <div style={{ color: '#6B7286', fontSize: 11.5 }}>Tampere · kysyntäsignaalit ennen pyyntöä</div>
              </div>
            </div>
            <div style={{ color: '#E8A94D', fontSize: 15, fontFamily: "'JetBrains Mono', monospace" }}>
              {formatClock(nowMinutes, clockSeconds)}
            </div>
          </div>
        </div>

        {hero && (
          <div style={{ margin: '4px 16px 16px', padding: 16, borderRadius: 14, background: '#161A24', border: '1px solid #262B38' }}>
            <div style={{ color: '#6B7286', fontSize: 12, marginBottom: 8 }}>
              {hero.delta <= 0 ? 'Tapahtuu juuri nyt' : `${hero.delta} min kuluttua`}
            </div>
            <div className="flex items-start gap-3">
              <div style={{ color: '#E8A94D' }}>
                {(() => {
                  const Icon = TYPE_META[hero.type].icon;
                  return <Icon size={22} strokeWidth={2} />;
                })()}
              </div>
              <div className="flex-1">
                <div style={{ color: '#F5F6F8', fontWeight: 700, fontSize: 17 }}>{hero.title}</div>
                <div style={{ color: '#9CA2B4', fontSize: 13.5, marginTop: 2 }}>{hero.detail}</div>
                <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-1" style={{ color: '#6B7286', fontSize: 12.5 }}>
                    <MapPin size={12} />
                    <span>{hero.location}</span>
                  </div>
                  <DemandBars level={hero.demand} />
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={{ padding: '0 16px 14px', color: '#6B7286', fontSize: 12.5 }}>
          {upcomingHourCount} saapumista seuraavan tunnin aikana
        </div>

        <div className="flex gap-1.5" style={{ padding: '0 16px 16px', overflowX: 'auto' }}>
          {FILTERS.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className="kt-tab"
                style={{
                  padding: '9px 14px',
                  borderRadius: 9999,
                  fontSize: 13,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  border: active ? '1px solid rgba(232,169,77,0.5)' : '1px solid #262B38',
                  color: active ? '#E8A94D' : '#8A90A3',
                  background: active ? 'rgba(232,169,77,0.08)' : 'transparent',
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {grouped.length === 0 && !hero && (
          <div style={{ padding: '32px 16px', color: '#6B7286', fontSize: 13.5, textAlign: 'center' }}>
            Ei näkyviä saapumisia tällä suodattimella juuri nyt.
          </div>
        )}

        {grouped.map((g) => (
          <div key={g.band}>
            <div style={{ padding: '10px 16px 6px', color: BAND_COLOR[g.band], fontSize: 12, fontWeight: 700 }}>
              {BAND_LABEL[g.band]}
            </div>
            <div style={{ borderTop: '1px solid #20242F' }}>
              {g.items.map((s) => (
                <Row key={s.id} signal={s} />
              ))}
            </div>
          </div>
        ))}

        <div style={{ margin: '24px 16px 0', padding: '12px 14px', borderRadius: 12, border: '1px dashed #2A3040', color: '#5C6272', fontSize: 12.5, lineHeight: 1.5 }}>
          Suunnitteilla: yhteys Tampereen taksivälitykseen (Movit / iCabbi), jotta välitetyt kyydit näkyisivät samassa näkymässä.
        </div>
      </div>
    </div>
  );
}
