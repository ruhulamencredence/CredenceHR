// Ride assignment -> the driver picker (GET /api/vehicles/driver-picker).
import { personLabel } from './personLabel';
import { slotClash, busyLabel, type RideTime, type SlotBooking } from './vehicleSlots';
// With Vehicle Management -> Inventory -> Drivers in use the list holds only
// its active drivers, with what each is doing now; until then every account
// (registered: false), as before.
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
  // Every vehicle this driver usually drives (one driver may have several).
  usual_vehicle_ids?: number[];
  // Rides this driver is booked for, with the gap kept around them (vehicleSlots.ts).
  bookings?: SlotBooking[];
  gap_minutes?: number;
}

// Busy for this ride's time (another ride + the gap overlaps it)?
export const driverBusy = (d: DriverOption, t?: RideTime | null) => (t ? slotClash(d, t) : null);

const isUsual = (d: DriverOption, vehicleId?: string | number) =>
  !!vehicleId && ((d.usual_vehicle_ids || []).includes(Number(vehicleId)) || Number(vehicleId) === Number(d.usual_vehicle_id));

const NOW_LABEL: Record<string, string> = { free: 'Available', assigned: 'Has a ride booked', on_ride: 'On a ride' };

// "Name · ID · Designation · Department — Available" (searchable by all of it).
// With the ride's time (t), "Free at this time" or "Busy 10:00–13:00 · Rahim"
// in place of what they are doing right now.
export function driverOptionLabel(d: DriverOption, vehicleId?: string | number, t?: RideTime | null): string {
  const clash = driverBusy(d, t);
  if (!d.registered) return t ? `${personLabel(d)} — ${clash ? busyLabel(clash, t) : 'Free at this time'}` : personLabel(d);
  const who = [d.name, d.employee_code, d.designation, d.department].filter(Boolean).join(' · ');
  const now = t ? (clash ? busyLabel(clash, t) : 'Free at this time') : NOW_LABEL[d.now || 'free'];
  const state =
    d.license_state === 'expired'
      ? 'license expired — update it first'
      : [now, d.license_state === 'expiring' ? `license ends ${d.license_expiry}` : '', isUsual(d, vehicleId) ? 'usual driver' : '']
          .filter(Boolean)
          .join(', ');
  return `${who} — ${state}`;
}

// Free drivers first, the vehicle's usual driver at the top, expired licenses last.
export function sortDrivers(list: DriverOption[], vehicleId?: string | number, t?: RideTime | null): DriverOption[] {
  const rank = (d: DriverOption) =>
    (d.license_state === 'expired' ? 100 : 0) +
    (t ? (driverBusy(d, t) ? 50 : 0) : d.now === 'on_ride' ? 20 : d.now === 'assigned' ? 10 : 0) -
    (isUsual(d, vehicleId) ? 5 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
