// The pages this account can open, as the sidebar (GlobalSidebar.tsx) built
// them — already filtered by its modules and switches — so the Dashboard's
// search (DashboardGreeting.tsx) offers exactly the menu, nothing more.

export interface NavEntry {
  key: string;
  label: string;
  onClick: () => void;
}

let entries: NavEntry[] = [];

export const setNavEntries = (list: NavEntry[]) => {
  entries = list;
};
export const getNavEntries = () => entries;
