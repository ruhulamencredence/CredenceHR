/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The app's Privacy Policy. Served publicly at /privacy (main.tsx picks this
// instead of <App /> for that path), because Google Play needs a policy URL
// that opens without signing in — so, unlike every other page, it has no
// permission gate. It is also opened inside the app (sign-in screen, the
// background-location disclosure) as an overlay, via `onClose`.
//
// Keep it in step with what the app really collects: when a feature starts
// collecting something new (a new Android permission, a new kind of record),
// add it to SECTIONS below and bump UPDATED.

import React from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

const APP_NAME = 'CredenceHR';
const COMPANY = 'Credence Housing Limited';
const COMPANY_ADDRESS = 'Dhaka, Bangladesh';
// Where people send privacy questions and data requests.
export const PRIVACY_CONTACT_EMAIL = 'info@credencehousinglimited.com';
const UPDATED = '6 October 2026';

type Block = string | { list: string[] };
const SECTIONS: { title: string; body: Block[] }[] = [
  {
    title: 'Who we are',
    body: [
      `${APP_NAME} is the internal HR app of ${COMPANY} (“we”, “us”) and of the companies that use it through us. It is meant only for our employees and for people their employer has given an account. There is no public sign-up.`,
      `The employer that created your account decides which features are switched on for you and is responsible for the HR records kept about you. ${COMPANY} runs the app and its server for them.`
    ]
  },
  {
    title: 'What we collect',
    body: [
      { list: [
        'Account and employee details: name, employee ID, email, phone number, department, designation, joining date, salary and payroll details, leave, loans, claims, documents and other HR records your employer keeps in the app.',
        'Attendance: check-in and check-out times, and the location of the phone at that moment.',
        'Location in the background (Android app only, and only if your employer turned on Employee Tracking for your account and you agreed): the phone’s location every few minutes during your signed-in session — even when the app is closed or not in use — together with the location accuracy and the battery level. While someone you are allowed to be followed by has you open in Live Follow, or while you are on a Book a Ride trip, it is sent every few seconds.',
        'Location for claims and rides: the places you pick or are at when you file a conveyance claim or book a ride.',
        'Photos, files and documents you upload (profile photo, claim receipts, documents, chat attachments).',
        'Chat messages, voice messages and calls: messages and voice notes are stored so the other person can read them; calls use the microphone (and the camera for video calls) only while a call is on and are not recorded.',
        'Device details: device ID and model, used to approve which phones can sign in to your account, and a notification token to send you push notifications.',
        'Basic logs: sign-in times, IP address and actions taken in the app, kept for security and audit.'
      ] }
    ]
  },
  {
    title: 'How we use it',
    body: [
      { list: [
        'To run HR work: attendance, leave, payroll, claims, approvals, rides, assets, tasks and reports.',
        'Background location is used only for Employee Tracking: to show your employer where field staff are during working hours, to check field visits and travel claims, and to show a ride’s progress. It is not used for advertising, it is not sold, and it is not used to build a profile of you for anyone outside your employer.',
        'To send you alerts and notifications about your requests and approvals.',
        'To keep the app secure (device approval, blocking misuse, audit logs).'
      ] }
    ]
  },
  {
    title: 'Who can see it',
    body: [
      'Only people in your employer’s organisation whose role allows it — for example your supervisor, HR and authorised admins — and only the parts their permissions allow. Location history is visible only to accounts given the Employee Tracking permission.',
      'We do not sell or rent personal data and we do not share it with advertisers. We share data outside your employer only when the law requires it, or with the services that run the app for us: the server host, and Google Firebase for push notifications. They may use it only to provide that service.'
    ]
  },
  {
    title: 'Your choices',
    body: [
      { list: [
        'Location: you can refuse, or later turn off, location access in your phone’s Settings → Apps → CredenceHR → Permissions → Location. The rest of the app keeps working; your employer will see that you are not being tracked, and attendance check-in may ask for your location again.',
        'Background tracking stops when you sign out. While it runs, Android shows a notification saying so.',
        'Notifications, microphone and camera can each be turned off in the phone’s Settings.',
        'You can ask HR to see, correct or export the records kept about you, and ask for your account to be closed. Some records (for example payroll and attendance) must be kept for the time the law requires even after you leave.'
      ] }
    ]
  },
  {
    title: 'How long we keep it',
    body: [
      'HR records are kept while you work for the employer and afterwards for as long as labour, tax and accounting law requires. Location history from Employee Tracking is kept for as long as your employer needs it for attendance, field-visit and claim checks; you can ask HR to have older history deleted.'
    ]
  },
  {
    title: 'How we protect it',
    body: [
      'Data is sent over encrypted connections (HTTPS) and stored on our server behind sign-in, per-feature permissions and device approval. Passwords are stored hashed, never in plain text.'
    ]
  },
  {
    title: 'Children',
    body: [`${APP_NAME} is a workplace app and is not meant for anyone under 18.`]
  },
  {
    title: 'Changes to this policy',
    body: ['If we change this policy we will update the date at the top of this page, and tell you in the app if the change is important.']
  },
  {
    title: 'Contact',
    body: [`${COMPANY}, ${COMPANY_ADDRESS}. Email: ${PRIVACY_CONTACT_EMAIL}. You can also contact your HR department.`]
  }
];

export const PrivacyPolicy: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const content = (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f5f3ff_0%,#ffffff_40%)] text-slate-800">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-[max(env(safe-area-inset-top),1.25rem)] pb-12">
        <div className="flex items-center gap-3">
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Back" className="liquid-glass-chip p-2 rounded-full text-slate-700">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <span className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center text-violet-600 shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900">Privacy Policy</h1>
            <p className="text-xs text-slate-500">
              {APP_NAME} · Last updated {UPDATED}
            </p>
          </div>
        </div>

        <p className="mt-5 text-sm leading-relaxed text-slate-700">
          This policy explains what personal data the {APP_NAME} app (Android, iPhone and web) collects, why, who can see it and the choices you
          have.
        </p>

        <div className="mt-6 space-y-6">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h2 className="text-base font-bold text-slate-900">{s.title}</h2>
              {s.body.map((b, i) =>
                typeof b === 'string' ? (
                  <p key={i} className="mt-2 text-sm leading-relaxed text-slate-700">
                    {b}
                  </p>
                ) : (
                  <ul key={i} className="mt-2 space-y-1.5 list-disc pl-5 text-sm leading-relaxed text-slate-700 marker:text-violet-500">
                    {b.list.map((li) => (
                      <li key={li}>{li}</li>
                    ))}
                  </ul>
                )
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
  if (!onClose) return content;
  return <div className="fixed inset-0 z-[1100] overflow-y-auto bg-white">{content}</div>;
};

export default PrivacyPolicy;
