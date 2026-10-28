/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Combobox } from './Combobox';

// Unit of an asset requisition / fulfilment line: type any unit, or pick one
// of the usual ones (Combobox, free).

export const ASSET_UNITS = ['pcs', 'box', 'set', 'pair', 'dozen', 'packet', 'ream', 'roll', 'sheet', 'bottle', 'carton', 'bag', 'kg', 'gram', 'litre', 'metre', 'feet', 'unit'];

export const UnitPicker: React.FC<{
  value: string;
  onChange: (unit: string) => void;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
}> = ({ ariaLabel = 'Unit', ...p }) => <Combobox free options={ASSET_UNITS} placeholder="pcs, box, kg…" ariaLabel={ariaLabel} {...p} />;
