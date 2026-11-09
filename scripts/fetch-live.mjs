// Astrotempo's live data jobs. Fetches, validates and writes the JSON files that astrotempo.com reads: its daily
// build takes them from this repository's Pages site, and the satellite pages load the newest orbital elements
// from it in the browser. A file is only replaced when the new data passes validation; otherwise the last good
// file stays and the script exits with code 1 (the workflow then opens an issue).
//
// Usage: node scripts/data/fetch-live.mjs <job...> [--out=dir]
//   jobs: smallbodies (JPL SBDB, daily), neo (JPL CNEOS close approaches, daily), satellites (CelesTrak, every 4 h),
//         nasa (NASA news headlines and Photojournal images per planet, daily),
//         spacecraft (JPL Horizons positions and paths of the spacecraft astrotempo.com lists, daily)
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, renameSync } from 'node:fs';

const args = process.argv.slice(2);
const OUT = (args.find((a) => a.startsWith('--out=')) ?? '--out=public/data/live').slice(6);
const jobs = args.filter((a) => !a.startsWith('--'));
const UA = 'astrotempo-data (https://github.com/LimpidMaja/astrotempo-data)';

// The spacecraft to follow (JPL Horizons ids, NASA feeds and Photojournal categories), as astrotempo.com lists them
// in /data/spacecraft-sources.json; the copy in this repository when the site cannot be reached.
const CRAFT_URL = process.env.CRAFT_URL ?? 'https://astrotempo.com/data/spacecraft-sources.json';
async function craftList() {
  try {
    const r = await fetch(CRAFT_URL, { headers: { 'User-Agent': UA } });
    if (r.status === 200) {
      const j = await r.json();
      if (j && typeof j.spacecraft === 'object' && Object.keys(j.spacecraft).length) return j.spacecraft;
    }
    console.error(`spacecraft list: HTTP ${r.status} from ${CRAFT_URL}, using the copy in the repository`);
  } catch (e) {
    console.error(`spacecraft list: ${e.message}, using the copy in the repository`);
  }
  return JSON.parse(readFileSync('spacecraft-sources.json', 'utf8')).spacecraft;
}
mkdirSync(OUT, { recursive: true });

class Invalid extends Error {}
const check = (cond, msg) => {
  if (!cond) throw new Invalid(msg);
};
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  // CelesTrak asks clients to stop on any non-200 reply rather than retry (usage policy).
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const nowJd = Date.now() / 864e5 + 2440587.5;

const JOBS = {
  /** Comets and bright asteroids: osculating elements at full precision (without it SBDB rounds to 3 digits). */
  async smallbodies() {
    const base = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api';
    const q = (kind, fields, cdata) => `${base}?fields=${fields}&sb-kind=${kind}&full-prec=1&sb-cdata=${encodeURIComponent(JSON.stringify(cdata))}`;
    // Comets that come within 5 au of the Sun, with a total magnitude parameter and elements no older than 3 years.
    const comets = await getJson(q('c', 'full_name,pdes,e,q,i,om,w,tp,epoch,M1,K1', { AND: ['q|LT|5', 'M1|DF', `epoch|GT|${Math.floor(nowJd - 3 * 365.25)}`] }));
    // Asteroids bright enough for binoculars at a good opposition (absolute magnitude H < 8).
    const asteroids = await getJson(q('a', 'full_name,pdes,e,q,i,om,w,tp,epoch,H,G', { AND: ['H|LT|8'] }));
    const rows = (r, kind) =>
      r.data.map((d) => {
        const o = Object.fromEntries(r.fields.map((f, i) => [f, d[i]]));
        const num = (k) => (o[k] === null || o[k] === undefined ? null : Number(o[k]));
        return {
          name: String(o.full_name).trim(),
          des: o.pdes,
          kind,
          elements: { e: num('e'), q: num('q'), i: num('i'), om: num('om'), w: num('w'), tp: num('tp'), epoch: num('epoch') },
          photometry: kind === 'comet' ? { M1: num('M1'), K1: num('K1') } : { H: num('H'), G: num('G') },
        };
      });
    const list = [...rows(comets, 'comet'), ...rows(asteroids, 'asteroid')];
    check(list.length > 50, `too few small bodies: ${list.length}`);
    for (const b of list) {
      const el = b.elements;
      check(['e', 'q', 'i', 'om', 'w', 'tp', 'epoch'].every((k) => finite(el[k])), `bad elements for ${b.name}`);
      check(el.e >= 0 && el.q > 0 && el.i >= 0 && el.i <= 180, `elements out of range for ${b.name}`);
    }
    return {
      file: 'smallbodies.json',
      meta: { source: 'NASA/JPL Small-Body Database Query API', source_url: 'https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html', license: 'US government data', credit: 'Orbits: NASA/JPL Small-Body Database', api_version: comets.signature?.version, records: list.length },
      data: list,
    };
  },

  /** Near-Earth object close approaches within 0.05 au in the next 60 days. */
  async neo() {
    const r = await getJson('https://ssd-api.jpl.nasa.gov/cad.api?date-min=now&date-max=%2B60&dist-max=0.05&fullname=true');
    check(r.signature?.version === '1.5', `CAD API version changed: ${r.signature?.version}`);
    const list = (r.data ?? []).map((d) => Object.fromEntries(r.fields.map((f, i) => [f, d[i]])));
    for (const a of list) check(finite(Number(a.dist)) && finite(Number(a.jd)), `bad close approach ${a.des}`);
    // Each object's orbit and brightness parameters (SBDB, full precision), so the site can predict how bright it
    // gets at closest approach. One request per object, gently; an object whose lookup fails just has no orbit.
    const orbits = {};
    for (const des of [...new Set(list.map((a) => a.des))]) {
      try {
        const j = await getJson(`https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${encodeURIComponent(des)}&full-prec=1&phys-par=1`);
        const el = Object.fromEntries((j.orbit?.elements ?? []).map((e) => [e.name, Number(e.value)]));
        const ph = Object.fromEntries((j.phys_par ?? []).map((p) => [p.name, Number(p.value)]));
        const o = { kind: String(j.object?.kind ?? '').startsWith('c') ? 'comet' : 'asteroid', e: el.e, q: el.q, i: el.i, om: el.om, w: el.w, tp: el.tp, epoch: Number(j.orbit?.epoch), H: finite(ph.H) ? ph.H : null, G: finite(ph.G) ? ph.G : null };
        if (['e', 'q', 'i', 'om', 'w', 'tp', 'epoch'].every((k) => finite(o[k]))) orbits[des] = o;
      } catch (err) {
        console.warn(`neo: no orbit for ${des}: ${err.message}`);
      }
      await new Promise((res) => setTimeout(res, 300));
    }
    for (const a of list) a.orbit = orbits[a.des] ?? null;
    return {
      file: 'neo-approaches.json',
      meta: { source: 'NASA/JPL CNEOS Close-Approach Data API', source_url: 'https://ssd-api.jpl.nasa.gov/doc/cad.html', license: 'US government data', credit: 'Close approaches: NASA/JPL CNEOS', api_version: r.signature.version, records: list.length },
      data: list,
    };
  },

  /** Space stations and the brightest satellites: GP orbit data for SGP4 (one request per group per update). */
  async satellites() {
    const groups = ['stations', 'visual'];
    const all = new Map();
    for (const g of groups) {
      const r = await getJson(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`);
      check(Array.isArray(r) && r.length > 0, `empty CelesTrak group ${g}`);
      for (const s of r) all.set(s.NORAD_CAT_ID, s);
    }
    const list = [...all.values()];
    for (const s of list) {
      check(s.OBJECT_NAME && finite(s.MEAN_MOTION) && finite(s.ECCENTRICITY) && s.EPOCH, `bad GP record ${s.NORAD_CAT_ID}`);
    }
    const iss = list.find((s) => s.NORAD_CAT_ID === 25544);
    check(iss, 'ISS missing from CelesTrak stations group');
    check(Math.abs(Date.parse(`${iss.EPOCH}Z`) - Date.now()) < 7 * 864e5, `ISS elements older than 7 days: ${iss.EPOCH}`);
    return {
      file: 'satellites.json',
      meta: { source: 'CelesTrak GP data', source_url: 'https://celestrak.org/NORAD/documentation/gp-data-formats.php', license: 'CelesTrak usage policy', credit: 'Orbital data: CelesTrak', groups, records: list.length },
      data: list,
    };
  },

  /**
   * Latest NASA news headlines (www.nasa.gov category feeds) and Photojournal images (science.nasa.gov) for the
   * Sun, the Moon and each planet. Images keep NASA's credit line; anything marked as copyrighted, and artist's
   * impressions, are skipped. Originals go to photos/; the site's build turns them into small WebP files.
   */
  async nasa() {
    const BODIES = {
      Sun: [11310, 3455],
      Moon: [3760, 533],
      Mercury: [3226, 3424],
      Venus: [3227, 1984],
      Mars: [3229, 1961],
      Jupiter: [3230, 1953],
      Saturn: [3231, 1971],
      Uranus: [3232, 1980],
      Neptune: [3233, 1967],
    };
    const PHOTOJOURNAL = 19797;
    // A photo must be about the body (category tags are loose: the Moon's include lab hardware).
    const ABOUT = { Sun: /\b(sun|solar|corona|sunspot)/i, Moon: /\b(moon|lunar)\b/i };
    // HTML entities in NASA's titles and credits (named accented letters and numeric codes).
    const NAMED = { ouml: 'ö', auml: 'ä', uuml: 'ü', Ouml: 'Ö', Auml: 'Ä', Uuml: 'Ü', szlig: 'ß', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', agrave: 'à', egrave: 'è', ograve: 'ò', ccedil: 'ç', ntilde: 'ñ', ocirc: 'ô', ecirc: 'ê', acirc: 'â', scaron: 'š', ccaron: 'č', zcaron: 'ž', Scaron: 'Š', Ccaron: 'Č', Zcaron: 'Ž' };
    const entities = (x) => x.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&([A-Za-z]+);/g, (m, n) => NAMED[n] ?? m);
    const text = (s) => entities(String(s ?? '').replace(/<[^>]+>/g, '').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;|&lsquo;/g, '‘').replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”').replace(/&#8211;/g, '–').replace(/&#8212;/g, '—').replace(/&copy;|&#169;/g, '©').replace(/&amp;/g, '&').replace(/&#038;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    const getText = async (url) => {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
      return res.text();
    };
    // Photos go to a fresh folder that replaces the old one only when the job succeeds, so old photos never
    // pile up on the data branch and a failed run leaves the last good set in place.
    const NEW = `${OUT}/photos.new`;
    rmSync(NEW, { recursive: true, force: true });
    mkdirSync(NEW, { recursive: true });
    const data = {};
    let photoCount = 0;
    // News: a feed mixes stories and news releases; the newest `max` are kept. One failing feed only costs that
    // page its news (the job checks below that most feeds answered).
    const newsFrom = async (url, label, max = 6) => {
      let xml = '';
      try {
        xml = await getText(url);
      } catch (e) {
        console.error(`nasa: news feed for ${label}: ${e.message}`);
      }
      return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
        .map((m) => {
          const get = (tag) => (m[1].match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)) ?? [])[1];
          const d = new Date(get('pubDate') ?? '');
          return { title: text(get('title')), link: text(get('link')), date: Number.isNaN(d.getTime()) ? null : d.toISOString() };
        })
        .filter((n) => n.title && n.date && /^https:\/\/(www|science)\.nasa\.gov\//.test(n.link))
        .slice(0, max);
    };
    // Photos: Photojournal posts tagged with the category; `about` (if given) must match the title or alt text.
    const photosFrom = async (cat, label, about, max = 6) => {
      let posts = [];
      try {
        posts = await getJson(`https://science.nasa.gov/wp-json/wp/v2/posts?categories%5Bterms%5D=${PHOTOJOURNAL},${cat}&categories%5Boperator%5D=AND&per_page=20&_fields=id,date,link,title,featured_media`);
      } catch (e) {
        console.error(`nasa: photos for ${label}: ${e.message}`);
      }
      const photos = [];
      for (const p of posts) {
        if (photos.length >= max) break;
        const title = text(p.title?.rendered);
        // Real views only: no artist's impressions, diagrams or hardware in the test lab.
        if (!p.featured_media || /artist|illustration|concept|animation|gif|graphic|diagram|test|prototype|simulant|clean room|assembly|COLDArm|scoop|instrument/i.test(title)) continue;
        let m;
        try {
          m = await getJson(`https://science.nasa.gov/wp-json/wp/v2/media/${p.featured_media}?_fields=source_url,credits,caption,alt_text,media_details`);
        } catch {
          continue;
        }
        const credit = text(m.credits);
        // NASA, JPL, ESA and ESO images (ESO and citizen processing under CC BY are fine with credit);
        // anything else marked as copyrighted is left out.
        if (!credit || !/NASA|JPL|ESA|ESO/.test(credit)) continue;
        // Only licences that allow an ad-supported site: no NonCommercial or NoDerivatives terms at all.
        if (/\bNC\b|NonCommercial|\bND\b|NoDerivs|NoDerivatives/i.test(credit)) continue;
        if (/©|\(c\)|copyright/i.test(credit) && !/CC BY(-SA)?(?![-\s]*(NC|ND))/.test(credit)) continue;
        if (about && !about.test(`${title} ${text(m.alt_text)}`)) continue;
        const w = m.media_details?.width;
        const h = m.media_details?.height;
        if (!m.source_url || !w || !h) continue;
        // The same image under two pages (a planet and a spacecraft) is downloaded once.
        if (!existsSync(`${NEW}/${p.id}.img`)) {
          const img = await fetch(`${m.source_url}?w=1200`, { headers: { 'User-Agent': UA } });
          if (img.status !== 200) continue;
          writeFileSync(`${NEW}/${p.id}.img`, Buffer.from(await img.arrayBuffer()));
          photoCount++;
        }
        const pia = (text(m.caption?.rendered).match(/PIA\d{5}/) ?? [])[0] ?? null;
        photos.push({ id: p.id, title, date: new Date(p.date).toISOString(), link: p.link, credit, pia, alt: text(m.alt_text), width: w, height: h, file: `photos/${p.id}.img` });
      }
      return photos;
    };
    for (const [body, [wwwCat, sciCat]] of Object.entries(BODIES)) {
      const news = await newsFrom(`https://www.nasa.gov/feed/?cat=${wwwCat}`, body);
      const photos = await photosFrom(sciCat, body, ABOUT[body] ?? new RegExp(`\\b${body}`, 'i'));
      data[body] = { news, photos };
    }
    // The space station's news, and each spacecraft's news and newest Photojournal images where NASA has them
    // (the spacecraft list gives the feed and category per spacecraft), four images each.
    data.ISS = { news: await newsFrom('https://www.nasa.gov/missions/station/feed/', 'ISS'), photos: [] };
    // (NASA's Photojournal has no category for the station: its page shows the site's own photos.)
    // NASA's "Eclipses" category, for the eclipses pages (no Photojournal category: they show the site's own photos).
    data.eclipses = { news: await newsFrom('https://www.nasa.gov/feed/?cat=9457', 'eclipses'), photos: [] };
    for (const [slug, sc] of Object.entries(await craftList())) {
      if (!sc.nasa?.newsFeed && !sc.nasa?.photojournalCategory) continue;
      const news = sc.nasa.newsFeed ? await newsFrom(sc.nasa.newsFeed, slug) : [];
      const photos = sc.nasa.photojournalCategory ? await photosFrom(sc.nasa.photojournalCategory, slug, null, 4) : [];
      if (news.length || photos.length) data[`craft:${slug}`] = { news, photos };
    }
    check(Object.keys(BODIES).filter((b) => data[b].news.length).length >= 6, 'too few news feeds answered');
    check(photoCount >= 10, `too few photos: ${photoCount}`);
    rmSync(`${OUT}/photos`, { recursive: true, force: true });
    renameSync(NEW, `${OUT}/photos`);
    return {
      file: 'nasa.json',
      meta: {
        source: 'NASA news feeds (www.nasa.gov) and NASA Photojournal (science.nasa.gov)',
        source_url: 'https://science.nasa.gov/photojournal/',
        license: 'NASA media usage guidelines (credit NASA; no endorsement implied): https://www.nasa.gov/nasa-brand-center/images-and-media/',
        credit: 'News and images: NASA (credit line of each image as published)',
        records: photoCount,
      },
      data,
    };
  },

  /**
   * Deep-space spacecraft from JPL Horizons: today's position seen from Earth (RA/Dec, distances, constellation)
   * and the heliocentric path every 15 days from a year ago to a year ahead (within each trajectory's range).
   * One spacecraft failing (for example a trajectory file that has ended) does not stop the others.
   */
  async spacecraft() {
    const list = await craftList();
    const day = (d) => d.toISOString().slice(0, 10);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const horizons = async (params) => {
      const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const r = await getJson(`https://ssd.jpl.nasa.gov/api/horizons.api?format=json&${q}`);
      const text = r.result ?? '';
      const a = text.indexOf('$$SOE');
      const b = text.indexOf('$$EOE');
      if (a < 0 || b < 0) throw new Error(text.split('\n').find((l) => /No ephemeris|Cannot|error/i.test(l)) ?? 'no ephemeris');
      return text.slice(a + 5, b).trim().split('\n').map((l) => l.split(',').map((x) => x.trim()));
    };
    const sexa = (h, m, sec) => Number(h.replace('-', '')) + Number(m) / 60 + Number(sec) / 3600;
    const data = {};
    for (const [slug, sc] of Object.entries(list)) {
      try {
        const id = String(sc.horizonsId);
        const obs = await horizons({ COMMAND: `'${id}'`, MAKE_EPHEM: 'YES', EPHEM_TYPE: 'OBSERVER', CENTER: "'500@399'", START_TIME: `'${day(today)}'`, STOP_TIME: `'${day(new Date(today.getTime() + 864e5))}'`, STEP_SIZE: "'1 d'", QUANTITIES: "'1,19,20,29'", CSV_FORMAT: 'YES', OBJ_DATA: 'NO' });
        const row = obs[0];
        const [rh, rm, rs] = row[3].split(/\s+/);
        const [dd, dm, ds] = row[4].split(/\s+/);
        const now = {
          time: today.toISOString(),
          ra: sexa(rh, rm, rs),
          dec: (row[4].startsWith('-') ? -1 : 1) * sexa(dd, dm, ds),
          r: Number(row[5]),
          rdot: Number(row[6]),
          delta: Number(row[7]),
          deldot: Number(row[8]),
          con: row[9],
        };
        check([now.ra, now.dec, now.r, now.delta].every(finite), `bad observer row for ${slug}`);
        // Path: within the trajectory's coverage. Many files are rolled forward by JPL every week or month, so the
        // recorded end is only a hint: when Horizons refuses a date it names the file's last one, and the request is
        // made again up to the day before that.
        const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
        const lastDay = (msg) => {
          const m = /after A\.D\. (\d{4})-([A-Z]{3})-(\d{2})/.exec(msg);
          if (!m) console.error(`spacecraft ${slug}: no end date in Horizons' reply, not retried: ${msg}`);
          return m ? Date.UTC(Number(m[1]), MON[m[2]], Number(m[3])) - 864e5 : null;
        };
        const upTo = async (end, request) => {
          try {
            return await request(end);
          } catch (e) {
            const last = lastDay(e.message);
            if (last === null || last <= today.getTime()) throw e;
            return request(last);
          }
        };
        const lo = new Date(Math.max(today.getTime() - 365 * 864e5, Date.parse(sc.horizonsRange.start) + 864e5));
        const vec = await upTo(Math.min(today.getTime() + 365 * 864e5, Math.max(Date.parse(sc.horizonsRange.stop) - 864e5, today.getTime() + 30 * 864e5)), (end) =>
          horizons({ COMMAND: `'${id}'`, MAKE_EPHEM: 'YES', EPHEM_TYPE: 'VECTORS', CENTER: "'500@10'", START_TIME: `'${day(lo)}'`, STOP_TIME: `'${day(new Date(end))}'`, STEP_SIZE: "'15 d'", VEC_TABLE: "'1'", OUT_UNITS: "'AU-D'", CSV_FORMAT: 'YES', OBJ_DATA: 'NO' }),
        );
        // Rounded to 1e-8 au (about 1.5 km) and 1e-5 day: the browser loads this file for the 3D views.
        const round = (c) => [Math.round(Number(c[0]) * 1e5) / 1e5, ...[c[2], c[3], c[4]].map((v) => Math.round(Number(v) * 1e8) / 1e8)];
        const path = vec.map(round).filter((p) => p.every(finite));
        check(path.length > 2, `short path for ${slug}`);
        // Near Earth (the Moon, the L1 and L2 points, high Earth orbit): the 15-day heliocentric path cannot place
        // them in our sky, so a geocentric path for the coming weeks is added for the 3D views. Craft in Earth orbit
        // (Chandra, SMILE and TESS circle Earth in days) need an hourly table over a shorter span to be followed (within
        // about half a degree).
        let geo;
        if (now.delta < 0.1) {
          // Moon orbiters stay within about 0.3° of the Moon, which the 12-hour table follows well.
          const close = now.delta < 0.005 && sc.group !== 'moon';
          try {
            const g = await upTo(today.getTime() + (close ? 30 : 90) * 864e5, (end) =>
              horizons({ COMMAND: `'${id}'`, MAKE_EPHEM: 'YES', EPHEM_TYPE: 'VECTORS', CENTER: "'500@399'", START_TIME: `'${day(new Date(today.getTime() - (close ? 2 : 5) * 864e5))}'`, STOP_TIME: `'${day(new Date(end))}'`, STEP_SIZE: close ? "'1 h'" : "'12 h'", VEC_TABLE: "'1'", OUT_UNITS: "'AU-D'", CSV_FORMAT: 'YES', OBJ_DATA: 'NO' }),
            );
            geo = g.map((c) => [Math.round(Number(c[0]) * 1e5) / 1e5, ...[c[2], c[3], c[4]].map((v) => Math.round(Number(v) * 1e9) / 1e9)]).filter((p) => p.every(finite));
          } catch (e) {
            console.error(`spacecraft ${slug}: geocentric path: ${e.message}`);
          }
        }
        data[slug] = geo && geo.length > 2 ? { now, path, geo } : { now, path };
      } catch (e) {
        console.error(`spacecraft ${slug}: ${e.message}`);
      }
    }
    check(Object.keys(data).length >= Object.keys(list).length - 4, `too few spacecraft: ${Object.keys(data).length}`);
    return {
      file: 'spacecraft.json',
      meta: { source: 'JPL Horizons System', source_url: 'https://ssd.jpl.nasa.gov/horizons/', license: 'US government data', credit: 'Spacecraft positions: NASA/JPL Horizons', records: Object.keys(data).length, note: 'now: geocentric astrometric RA (h)/Dec (deg), r and delta in au, rdot and deldot in km/s; path: [JD TDB, x, y, z] heliocentric ecliptic J2000, au, every 15 days; geo (craft within 0.1 au): the same, geocentric, every 12 hours for the coming weeks (hourly for 30 days within 0.005 au).' },
      data,
    };
  },
};

let failed = false;
for (const name of jobs) {
  const job = JOBS[name];
  if (!job) {
    console.error(`unknown job ${name}`);
    failed = true;
    continue;
  }
  try {
    const { file, meta, data } = await job();
    writeFileSync(`${OUT}/${file}`, JSON.stringify({ meta: { ...meta, fetched_at: new Date().toISOString() }, data }));
    console.log(`${name}: ${meta.records} records -> ${OUT}/${file}`);
  } catch (err) {
    failed = true;
    console.error(`${name} FAILED, previous file (if any) kept: ${err.message}`);
  }
}
// Index of what is available and when it was fetched, for the pages' "data sources" boxes.
const index = {};
for (const f of ['smallbodies.json', 'neo-approaches.json', 'satellites.json', 'nasa.json', 'spacecraft.json']) {
  if (existsSync(`${OUT}/${f}`)) index[f] = JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8')).meta;
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
process.exit(failed ? 1 : 0);
