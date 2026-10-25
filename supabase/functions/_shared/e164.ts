// WhatsApp wa_id is the phone number in international format without "+".
export function waIdToE164(waId: string): string {
  if (!/^[1-9][0-9]{6,14}$/.test(waId)) throw new Error(`not a wa_id: ${waId}`);
  return `+${waId}`;
}

export function e164ToWaId(e164: string): string {
  if (!/^\+[1-9][0-9]{6,14}$/.test(e164)) throw new Error(`not E.164: ${e164}`);
  return e164.slice(1);
}
