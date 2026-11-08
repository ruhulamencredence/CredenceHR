/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A password field with an eye button to show / hide what was typed. Takes
// every normal <input> prop; the field keeps its own className / style and
// gets room on the right for the button.

import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { iconColor?: string };

export const PasswordInput: React.FC<Props> = ({ className = '', style, iconColor, ...rest }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input {...rest} type={show ? 'text' : 'password'} className={className} style={{ ...style, paddingRight: 44 }} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center hover:bg-black/5"
        style={{ color: iconColor || '#64748b' }}
        aria-label={show ? 'Hide password' : 'Show password'}
        title={show ? 'Hide password' : 'Show password'}
        tabIndex={-1}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
};
