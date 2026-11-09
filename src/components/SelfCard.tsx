/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ChevronRight } from 'lucide-react';

// The Employee Directory card (EmployeeDirectory.tsx, phone), shared by the
// list cards of every Self Service page on a phone: a soft tinted gradient,
// big round corners and a thin white border; a round icon / initials on the
// left with the title and one line under it; small chips below with round
// action buttons on the right. The tint follows the item's state — green
// done, amber waiting, rose missed / turned down — and the plain list
// colours (violet, blue, cyan) for things that have no state of their own.
// Desktop keeps each page's own markup; only the phone uses this.

export type CardTone = 'green' | 'amber' | 'rose' | 'violet' | 'blue' | 'cyan' | 'slate';

const CARD_TINT: Record<CardTone, string> = {
  green: 'from-emerald-100/70 via-white/50 to-teal-50/40',
  amber: 'from-amber-100/70 via-white/50 to-orange-50/40',
  rose: 'from-rose-100/70 via-white/50 to-pink-50/40',
  violet: 'from-violet-100/70 via-white/50 to-fuchsia-50/40',
  blue: 'from-blue-100/70 via-white/50 to-indigo-50/40',
  cyan: 'from-cyan-100/70 via-white/50 to-sky-50/40',
  slate: 'from-slate-100/70 via-white/50 to-zinc-50/40'
};
const LEAD: Record<CardTone, string> = {
  green: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700',
  rose: 'bg-rose-100 text-rose-700',
  violet: 'bg-violet-100 text-violet-700',
  blue: 'bg-blue-100 text-blue-700',
  cyan: 'bg-cyan-100 text-cyan-700',
  slate: 'bg-slate-100 text-slate-600'
};
const CHIP_TEXT: Record<CardTone, string> = {
  green: 'text-emerald-700 font-bold',
  amber: 'text-amber-700 font-bold',
  rose: 'text-rose-700 font-bold',
  violet: 'text-violet-700 font-bold',
  blue: 'text-blue-800 font-bold',
  cyan: 'text-cyan-800 font-bold',
  slate: 'text-slate-700'
};
const DOT: Record<CardTone, string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-500',
  violet: 'bg-violet-400',
  blue: 'bg-blue-400',
  cyan: 'bg-cyan-400',
  slate: 'bg-slate-300'
};

// A status word -> its tone. Unknown words are a plain (blue) list item.
export function toneOfStatus(status?: string | null): CardTone {
  const s = String(status || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (/^(approved|done|completed|complete|paid|fully_paid|settled|cleared|active|signed|acknowledged|issued|delivered|received|returned|ontime|on_time|present|resolved|closed_resolved|accepted|fulfilled|ready|in_use|assigned_done)$/.test(s)) return 'green';
  if (/^(rejected|declined|cancelled|canceled|absent|overdue|expired|failed|withdrawn|terminated|lost|damaged|missed)$/.test(s)) return 'rose';
  if (/^(pending|review|reviewing|in_review|open|in_progress|running|waiting|submitted|requested|draft|processing|ongoing|assigned|on_hold|hold|delay|late|partially_paid|return_requested|awaiting|sent)$/.test(s)) return 'amber';
  return 'blue';
}

export interface CardChip {
  label: React.ReactNode;
  tone?: CardTone;
  mono?: boolean;
  icon?: React.ReactNode;
}

export const SelfChip: React.FC<CardChip> = ({ label, tone, mono, icon }) => (
  <span
    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-white/50 border border-white/60 whitespace-nowrap ${
      mono ? 'font-mono text-slate-700' : tone ? CHIP_TEXT[tone] : 'text-slate-700 font-semibold'
    }`}
  >
    {icon}
    {label}
  </span>
);

// A round white action button inside a card (view, download, approve…).
export const CardButton: React.FC<{
  label: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  tone?: 'green' | 'rose' | 'accent';
  disabled?: boolean;
}> = ({ label, onClick, children, tone, disabled }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={(e) => {
      e.stopPropagation();
      onClick(e);
    }}
    className={`w-8 h-8 rounded-full bg-white/75 border border-white/60 shadow-sm flex items-center justify-center transition-colors disabled:opacity-40 ${
      tone === 'green' ? 'text-emerald-600' : tone === 'rose' ? 'text-rose-600' : tone === 'accent' ? 'text-[color:var(--g-accent)]' : 'text-slate-600'
    }`}
  >
    {children}
  </button>
);

export const SelfCard: React.FC<{
  tone: CardTone;
  // Round tile on the left: an icon, initials or a short code (CL, 12…).
  lead: React.ReactNode;
  // Own colours for the tile (e.g. the leave type's), in place of the tone's.
  leadStyle?: React.CSSProperties;
  // A small dot on the tile's corner (e.g. a day's state); its colour.
  dot?: CardTone;
  title: React.ReactNode;
  sub?: React.ReactNode;
  chips?: CardChip[];
  // Round buttons on the right of the chip row (CardButton).
  actions?: React.ReactNode;
  onClick?: () => void;
  // Shown under the chip row (a note, a progress bar, a form…).
  children?: React.ReactNode;
  // Weekend / holiday rows: lighter, no tint.
  quiet?: boolean;
  className?: string;
}> = ({ tone, lead, leadStyle, dot, title, sub, chips, actions, onClick, children, quiet, className = '' }) => {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative shrink-0">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-extrabold ring-2 ring-white/80 shadow-sm ${leadStyle ? '' : LEAD[tone]}`} style={leadStyle}>{lead}</div>
            {dot && <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${DOT[dot]}`} />}
          </div>
          <div className="min-w-0">
            <div className={`font-semibold text-sm truncate ${quiet ? 'text-slate-500' : 'text-slate-900'}`}>{title}</div>
            {sub && <div className="text-xs text-slate-600 truncate">{sub}</div>}
          </div>
        </div>
        {onClick && <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
      </div>
      {((chips && chips.length > 0) || actions) && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1 min-w-0">
            {(chips || []).map((c, i) => (
              <SelfChip key={i} {...c} />
            ))}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </>
  );
  const cls = `relative block w-full text-left rounded-[28px] overflow-hidden border border-white/70 p-3 space-y-2 ${
    quiet ? 'bg-white/55' : `bg-gradient-to-br ${CARD_TINT[tone]} shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)]`
  } ${onClick ? 'active:scale-[0.99] transition-transform' : ''} ${className}`;
  // A card that opens something is a button; a card holding its own buttons
  // or form is a plain box with a role, so the buttons inside stay valid.
  return onClick ? (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={`${cls} cursor-pointer`}
    >
      {body}
    </div>
  ) : (
    <div className={cls}>{body}</div>
  );
};
