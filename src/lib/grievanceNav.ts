/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Where a Grievance / Disciplinary alert opens. The ones sent to HR (a new
// grievance, feedback or an acknowledgement from the employee) belong in
// Admin Panel -> HR Advanced -> Grievance & Disciplinary; the ones sent to
// the employee, the named person or an investigator stay in Self Service ->
// Grievance & Disciplinary (MyCases).

export type GrievanceAdminTab = 'grievances' | 'disciplinary';

export const GRIEVANCE_TAB_KEY = 'grievance_tab';
export const GRIEVANCE_TAB_EVENT = 'credence:grievance-tab';

const HR_SIDE_TITLES = /^(New Grievance Raised|Grievance Feedback Received|Disciplinary Feedback Received|Disciplinary Action Acknowledged)$/;

export const isHrSideCaseAlert = (title: string) => HR_SIDE_TITLES.test(String(title || '').trim());

export const openGrievanceAdmin = (tab: GrievanceAdminTab) => {
  try {
    sessionStorage.setItem(GRIEVANCE_TAB_KEY, tab);
  } catch {
    // storage unavailable — the event below still switches an open panel
  }
  window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'grievance_disciplinary' }));
  setTimeout(() => window.dispatchEvent(new CustomEvent(GRIEVANCE_TAB_EVENT, { detail: tab })), 0);
};
