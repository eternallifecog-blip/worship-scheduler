/**
 * Worship Scheduler — Reminder Email Script
 * GitHub Actions runs this every hour.
 * Admin controls frequency & time from the app Settings tab.
 * Reuses the Member Notification template (is_reminder="Yes" flag).
 * Only 2 EmailJS templates needed total.
 */

const fetch = require('node-fetch');

const FIREBASE_URL    = process.env.FIREBASE_URL;
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;
const EJS_SERVICE     = process.env.EMAILJS_SERVICE_ID;
const EJS_PUBLIC_KEY  = process.env.EMAILJS_PUBLIC_KEY;
const EJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

async function fbGet(path) {
  const url = `${FIREBASE_URL}/worship/${path}.json?auth=${FIREBASE_SECRET}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Firebase GET ${res.status}: ${path}`);
  return res.json();
}

async function fbSet(path, data) {
  const url = `${FIREBASE_URL}/worship/${path}.json?auth=${FIREBASE_SECRET}`;
  const res  = await fetch(url, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Firebase SET ${res.status}: ${path}`);
  return res.json();
}

async function sendEmail(templateId, params) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:      EJS_SERVICE,
      template_id:     templateId,
      user_id:         EJS_PUBLIC_KEY,
      accessToken:     EJS_PRIVATE_KEY,
      template_params: params
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`EmailJS ${res.status}: ${body}`);
  }
  return res.text();
}

const DAY_MAP = {
  sunday:0, monday:1, tuesday:2, wednesday:3,
  thursday:4, friday:5, saturday:6
};

function shouldSendNow(schedule, nowUtc) {
  if (!schedule || !schedule.days || schedule.hourPST === undefined) return false;

  // DST detection (PST=UTC-8, PDT=UTC-7)
  const year = nowUtc.getUTCFullYear();
  const dstStart = new Date(Date.UTC(year, 2, 1));
  dstStart.setUTCDate(1 + (7 - dstStart.getUTCDay()) % 7 + 7);
  const dstEnd = new Date(Date.UTC(year, 10, 1));
  dstEnd.setUTCDate(1 + (7 - dstEnd.getUTCDay()) % 7);
  const isDST     = nowUtc >= dstStart && nowUtc < dstEnd;
  const offset    = isDST ? 7 : 8;

  const localMs   = nowUtc.getTime() - offset * 3600000;
  const localDate = new Date(localMs);
  const localDay  = localDate.getUTCDay();
  const localHour = localDate.getUTCHours();

  const targetHour = parseInt(schedule.hourPST, 10) || 8;
  const dayMatch   = (schedule.days || []).some(d => DAY_MAP[d.toLowerCase()] === localDay);

  return dayMatch && localHour === targetHour;
}

async function main() {
  console.log('=== Worship Reminder Script ===');
  const nowUtc = new Date();
  console.log('UTC:', nowUtc.toISOString());

  if (!FIREBASE_URL || !FIREBASE_SECRET)
    { console.error('❌ Missing Firebase env vars'); process.exit(1); }
  if (!EJS_SERVICE || !EJS_PUBLIC_KEY || !EJS_PRIVATE_KEY)
    { console.error('❌ Missing EmailJS env vars'); process.exit(1); }

  // Load all settings and data
  const [reminderCfg, ejsCfg, services, users] = await Promise.all([
    fbGet('settings/reminder'),
    fbGet('settings/emailjs'),
    fbGet('services'),
    fbGet('users')
  ]);

  const schedule = reminderCfg || { days:['monday','friday'], hourPST:8 };
  const appUrl   = (ejsCfg && ejsCfg.appUrl) || '';
  // Reuse the member notification template — no separate reminder template needed
  const memberTpl = ejsCfg && ejsCfg.templateIdMember;

  console.log('Schedule:', JSON.stringify(schedule));

  if (!shouldSendNow(schedule, nowUtc)) {
    console.log('⏩ Not scheduled for this hour — done.');
    return;
  }
  console.log('✅ Time matches — sending reminders...');

  if (!memberTpl) { console.error('❌ templateIdMember not set in Firebase'); process.exit(1); }
  if (!services || !users) { console.log('No data.'); return; }

  // Human-readable schedule string for the email body
  const days     = (schedule.days||[]).map(d=>d.charAt(0).toUpperCase()+d.slice(1)).join(' & ');
  const h        = parseInt(schedule.hourPST,10)||8;
  const ampm     = h>=12?'PM':'AM';
  const h12      = h>12?h-12:(h||12);
  const schedStr = `Every ${days} at ${h12}:00 ${ampm} PST`;

  const todayStr = nowUtc.toISOString().split('T')[0];
  let sent=0, skipped=0;

  for (const [sid, svc] of Object.entries(services)) {
    if (!svc || !svc.slots) continue;
    if (svc.date < todayStr) continue; // skip past services

    const rsvp      = svc.rsvp || {};
    const songsList = svc.songs ? Object.values(svc.songs).join(', ') : 'No songs yet';

    // Full team list
    const teamLines = [];
    for (const [ins, members] of Object.entries(svc.slots))
      for (const uid of Object.keys(members))
        if (users[uid]) teamLines.push(`${ins}: ${users[uid].name}`);

    console.log(`\n📅 ${svc.name} — ${svc.date}`);

    for (const [ins, members] of Object.entries(svc.slots)) {
      for (const muid of Object.keys(members)) {
        const member = users[muid];
        const status = rsvp[muid] || 'pending';

        if (!member || !member.email) { console.log(`  ⚠️ No email: ${muid}`); continue; }

        if (status !== 'pending') {
          console.log(`  ✅ ${member.name} responded (${status}) — skip`);
          skipped++; continue;
        }

        const acceptUrl = `${appUrl}?rsvp=accept&sid=${sid}&uid=${muid}`;
        const denyUrl   = `${appUrl}?rsvp=deny&sid=${sid}&uid=${muid}`;

        console.log(`  📧 ${member.name} <${member.email}>`);
        try {
          await sendEmail(memberTpl, {
            to_email:      member.email,
            to_name:       member.name,
            instrument:    ins,
            svc_name:      svc.name,
            svc_date:      svc.date,
            svc_time:      svc.time,
            team_list:     teamLines.join('\n'),
            songs_list:    songsList,
            accept_url:    acceptUrl,
            deny_url:      denyUrl,
            is_reminder:   'Yes',         // template can use this to show "REMINDER:" prefix
            reminder_freq: schedStr
          });
          console.log(`  ✅ Sent`);
          sent++;
          await new Promise(r => setTimeout(r, 1200));
        } catch(err) {
          console.error(`  ❌ ${err.message}`);
        }
      }
    }
  }

  console.log(`\n=== Done: sent=${sent}, skipped=${skipped} ===`);
  await fbSet('settings/reminderLastRun', {
    timestamp: nowUtc.toISOString(), sent, skipped
  });
}
main().catch(err => { console.error('Fatal:', err); process.exit(1); });
