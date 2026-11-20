// Vehicles booked by time (VehicleManagementRoutes.ts, claimVehicle): a car
// and its driver are held only for each ride's own time plus the gap
// (Ride settings → Gap between rides). GET /api/vehicles/available and
// /api/vehicles/driver-picker send each one's bookings; these helpers mark a
// car or driver Free / Busy for the ride being given, so the pickers can put
// the free ones first and keep the busy ones from being picked. The server
// checks it again when the car is given.

export interface SlotBooking {
  requisition_id: number;
  start: string; // ISO
  end: string; // ISO
  status: string;
  who: string;
  leg: string | null;
}
export interface RideTime {
  start: number; // ms
  end: number; // ms
  id?: number; // the ride itself, never its own clash
}
export interface Slotted {
  bookings?: SlotBooking[];
  gap_minutes?: number;
}

// A ride's time from its fields (ride_date + start_time are Dhaka time).
export function rideTimeOf(r: { id?: number; ride_date?: string | null; start_time?: string | null; estimated_duration_hours?: number | string | null } | null | undefined): RideTime | null {
  if (!r || !r.ride_date || !r.start_time) return null;
  const d = String(r.ride_date).slice(0, 10);
  const m = /^(\d{1,2}):(\d{2})/.exec(String(r.start_time));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !m) return null;
  const start = Date.parse(`${d}T${m[1].padStart(2, '0')}:${m[2]}:00+06:00`);
  if (Number.isNaN(start)) return null;
  const hours = Number(r.estimated_duration_hours) > 0 ? Number(r.estimated_duration_hours) : 1;
  return { start, end: start + hours * 3600e3, id: r.id ? Number(r.id) : undefined };
}

// A pick-up leg: from pickup_at (or now, "when called") for an hour.
export function pickupTimeOf(r: { id?: number; pickup_at?: string | null }): RideTime {
  const start = r.pickup_at ? Date.parse(String(r.pickup_at)) : Date.now();
  return { start, end: start + 3600e3, id: r.id ? Number(r.id) : undefined };
}

export function slotClash(x: Slotted, t: RideTime | null): SlotBooking | null {
  if (!t) return null;
  const gap = (x.gap_minutes ?? 30) * 60e3;
  return (x.bookings || []).find((b) => b.requisition_id !== t.id && t.start < Date.parse(b.end) + gap && t.end > Date.parse(b.start) - gap) || null;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dhaka = (ms: number) => new Date(ms + 6 * 3600e3);
const hm = (ms: number) => dhaka(ms).toISOString().slice(11, 16);
const day = (ms: number) => {
  const d = dhaka(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}`;
};

// "Busy 10:00–13:00 (Rahim)"; with the date when it isn't the ride's own day.
export function busyLabel(b: SlotBooking, t: RideTime | null): string {
  const s = Date.parse(b.start);
  const e = Date.parse(b.end);
  const sameDay = t && day(s) === day(t.start) && day(e) === day(t.start);
  const span = sameDay ? `${hm(s)}–${hm(e)}` : `${day(s)} ${hm(s)} – ${day(e)} ${hm(e)}`;
  return `Busy ${span}${b.status === 'ongoing' ? ' (on the road)' : ''}${b.who ? ` · ${b.who}` : ''}`;
}

export interface SlotVehicle extends Slotted {
  id: number;
  vehicle_no: string;
  model: string;
  vehicle_type?: string | null;
  on_road?: boolean;
}

// A car for the picker: its label, whether it can be picked, free ones first.
export function vehicleChoices(list: SlotVehicle[], t: RideTime | null): { v: SlotVehicle; label: string; busy: boolean }[] {
  return list
    .map((v) => {
      const c = slotClash(v, t);
      const base = `${v.model} (${v.vehicle_no})`;
      return { v, busy: !!c, label: c ? `${base} — ${busyLabel(c, t)}` : t ? `${base} — Free at this time` : base };
    })
    .sort((a, b) => Number(a.busy) - Number(b.busy) || a.label.localeCompare(b.label));
}
