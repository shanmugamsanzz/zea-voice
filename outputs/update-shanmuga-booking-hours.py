from pathlib import Path

folder = Path('docs/prompts/shannmuga hospital')
for filename in ('INBOUND_PROMPT.md', 'OUTBOUND_PROMPT.md'):
    path = folder / filename
    text = path.read_text(encoding='utf-8')
    text = text.replace('Verified tools determine appointment slots, bookings and action outcomes.', 'Appointment times must follow the eight AM to eleven AM rule below; verified tools determine bookings and action outcomes.')
    start = text.index('## Appointment flow and exact tools\n')
    end = text.index('- manage_appointment:', start)
    text = text[:start] + '''## Appointment flow and exact tools
Booking needs request/agreement. Establish patient separately from caller; reuse known fields and ask missing required items one at a time. Resolve date/time using runtime Asia/Kolkata. Appointment times are ONLY 8:00 AM through 11:00 AM inclusive (08:00:00 to 11:00:00 local time). Do not check slots or require a slot-checking tool. Do not invent weekdays, holidays or capacity; these hours do not prove date-specific availability.
Reject times before eight AM or after eleven AM; never execute booking with an out-of-window time or silently change it. For two PM say naturally: "ரெண்டு மணிக்கு appointment இல்லங்க. Appointment time காலை எட்டு மணிலிருந்து பதினொரு மணி வரைக்கும் தான். இந்த நேரத்துக்குள்ள எந்த time வேணும்?" For other invalid times adapt the requested time. In English mode: "Appointments are only from eight AM to eleven AM. What time within those hours would you prefer?"
Bare eight, nine, ten or eleven in this booking context means AM. Bare two is outside the window in either AM or PM; explain the hours rather than asking AM/PM unnecessarily. Clarify other genuinely ambiguous times; never assume a missing date/time. Preserve all other known booking fields when correcting time. These appointment hours do not restrict separately agreed AI callbacks.
Use attached tools and actual schemas only:
- shanmuga-appoinment-book: exact booking tool name, never book_appointment. Execute after required patient fields, an agreed date/time within the window and clear booking consent. Existing explicit agreement is enough; do not ask it again. Do not require or invent a slot ID. If booking fails, explain the verified failure and clarify as needed; do not blindly create duplicates. If the booking tool is missing, explain staff must assist.
''' + text[end:]
    text = text.replace('all existing slot-check, consent, transfer, callback and success-verification rules remain in force.', 'all existing consent, transfer, callback and success-verification rules remain in force; apply the appointment hours above.')
    start = text.index('dateandtime is the agreed verified appointment slot,')
    end = text.index('\n', start)
    text = text[:start] + 'dateandtime is the agreed appointment date/time within 08:00:00 to 11:00:00 in Asia/Kolkata, serialized as YYYY-MM-DDTHH:mm:ss+05:30. Example 2026-10-23T09:30:00+05:30 is FORMAT ONLY, never a booking default. Resolve relative dates from runtime context; clarify missing date/time and genuine AM/PM ambiguity under the hours rule. Preserve the agreed instant when converting timezone; do not simply append an offset. Keep other existing required schema fields, but no slot ID is needed. No invented values or date/time from callback scheduling.' + text[end:]
    text = text.replace('not all tests or slot availability.', 'not all tests; appointment hours follow the explicit eight AM to eleven AM rule above.')
    assert 'check_appointment_slots' not in text
    assert 'verified slot' not in text
    path.write_text(text, encoding='utf-8')
    copy = Path('outputs/shanmuga-booking-prompts') / filename
    if copy.exists():
        copy.write_text(text, encoding='utf-8')
    print(filename, len(text), 'characters; hours and slot-tool removal verified')
