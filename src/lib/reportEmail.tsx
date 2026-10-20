/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Email reports (an "Email" button next to PDF) are not part of this server
// yet: these stand-ins keep the Assistant's report buttons to PDF / Excel.

import React from 'react';

export function useCanEmailReports(_token?: string): boolean {
  return false;
}

export const EmailReportButton: React.FC<any> = () => null;

export async function emailReport(..._args: any[]): Promise<void> {
  // Not available on this server.
}
