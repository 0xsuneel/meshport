// The admin panel is open (19 Nov 2026): helpers shared with the app (raw
// REST calls - lib/chatService authHeaders) then act with the admin's own
// sign-in (lib/adminDb), never the app's wallet sign-in in the same browser.
let on = false
export function setAdminMode(v: boolean): void { on = v }
export function isAdminMode(): boolean { return on }
