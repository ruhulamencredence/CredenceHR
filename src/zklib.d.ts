// node-zklib ships no TypeScript declarations of its own — this is a minimal
// shim covering just the methods zkSync.ts actually calls. Loosely typed
// (`any`) on purpose since the library's return shapes vary slightly by
// device firmware; zkSync.ts defensively reads multiple possible field names
// (deviceUserId/userId, recordTime/attTime) to cope with that.
declare module "node-zklib" {
  export default class ZKLib {
    constructor(ip: string, port?: number, timeout?: number, inport?: number);
    createSocket(): Promise<void>;
    disconnect(): Promise<void>;
    getInfo(): Promise<any>;
    getUsers(): Promise<{ data: any[] }>;
    getAttendances(callback?: (received: number, total: number) => void): Promise<{ data: any[] }>;
    getTime(): Promise<Date>;
    // Registers for live push notifications of new punches as they happen
    // (device stays connected and streams events) instead of returning a
    // batch. The callback may be async — its return value is ignored either
    // way, but zkSync.ts awaits inside it to safely serialize DB writes.
    getRealTimeLogs(callback: (data: any) => void | Promise<void>): Promise<void>;
    // Clears the device's onboard attendance buffer. Exported as a manual
    // option in zkSync.ts but not called anywhere automatically — old data
    // is never deleted from the terminals as a matter of policy.
    clearAttendanceLog(): Promise<void>;
  }
}