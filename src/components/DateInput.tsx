/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A date field that shows the app's date format, dd-mmm-yyyy ("02-Mar-1970"),
// instead of the browser's own (mm/dd/yyyy on many computers). The value in
// and out stays "YYYY-MM-DD", like <input type="date">.
//  - Type it: 02-Mar-1970, 2 mar 1970, 02/03/1970 or 1970-03-02 — read when
//    the field is left (or Enter); something unreadable goes back.
//  - Or tap the calendar icon: the phone's / browser's own date picker (a
//    real <input type="date"> sits over the icon, invisible, so it opens
//    everywhere, iPhone included).

import React, { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { formatDate, parseDateInput } from '../lib/formatDate';

export const DateInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  className?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  placeholder?: string;
  'aria-label'?: string;
}> = ({ value, onChange, className = '', min, max, disabled, placeholder = 'dd-mmm-yyyy', ...rest }) => {
  const [text, setText] = useState(formatDate(value));
  useEffect(() => setText(formatDate(value)), [value]);
  const commit = () => {
    if (!text.trim()) {
      if (value) onChange('');
      return;
    }
    const iso = parseDateInput(text);
    if (iso && (!min || iso >= min) && (!max || iso <= max)) {
      if (iso !== value) onChange(iso);
      setText(formatDate(iso));
    } else setText(formatDate(value));
  };
  return (
    <div className="relative">
      <input
        type="text"
        inputMode="text"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={rest['aria-label']}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        className={`${className} pr-10`}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
        <CalendarDays className="w-4 h-4" />
      </span>
      {/* The phone's / browser's date picker, under the icon. */}
      <input
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={value || ''}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="absolute right-0 top-0 h-full w-10 opacity-0 cursor-pointer"
      />
    </div>
  );
};

export default DateInput;
