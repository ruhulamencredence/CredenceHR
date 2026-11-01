// Ride assignment -> the driver picker (GET /api/vehicles/driver-picker).
// Inventory -> Drivers' active drivers first (registered: true, with what
// each is doing now and their license), then every other login account
// (registered: false — not on the list, no license on file), so the rider
// or anyone else can be set as the driver.
export interface DriverOption {
  id: number;
  name: string;
  registered: boolean;
  employee_code?: string;
  designation?: string;
  department?: string;
  now?: 'free' | 'assigned' | 'on_ride';
  license_state?: 'valid' | 'expiring' | 'expired' | 'unknown';
  license_expiry?: string | null;
  usual_vehicle_id?: number | null;
}

const NOW_LABEL: Record<string, string> = { free: 'Available', assigned: 'Has a ride booked', on_ride: 'On a ride' };

// "Name · ID · Designation · Department — Available" (searchable by all of it).
export function driverOptionLabel(d: DriverOption, vehicleId?: string | number): string {
  const who = [d.name, d.employee_code, d.designation, d.department].filter(Boolean).join(' · ');
  if (!d.registered) return `${who} — not on Drivers list`;
  const state =
    d.license_state === 'expired'
      ? 'license expired — update it first'
      : [NOW_LABEL[d.now || 'free'], d.license_state === 'expiring' ? `license ends ${d.license_expiry}` : '', vehicleId && Number(vehicleId) === Number(d.usual_vehicle_id) ? 'usual driver' : '']
          .filter(Boolean)
          .join(', ');
  return `${who} — ${state}`;
}

// The rider first (self-drive), then listed drivers — free ones and the
// vehicle's usual driver at the top, expired licenses last — then everyone
// not on the Drivers list.
export function sortDrivers(list: DriverOption[], vehicleId?: string | number, riderId?: string | number | null): DriverOption[] {
  const rank = (d: DriverOption) =>
    (riderId && Number(riderId) === Number(d.id) ? -1000 : 0) +
    (d.registered ? 0 : 500) +
    (d.license_state === 'expired' ? 100 : 0) + (d.now === 'on_ride' ? 20 : d.now === 'assigned' ? 10 : 0) - (vehicleId && Number(vehicleId) === Number(d.usual_vehicle_id) ? 5 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
