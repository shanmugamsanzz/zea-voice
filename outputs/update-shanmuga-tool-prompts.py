from pathlib import Path
import difflib

root = Path('docs/prompts/shannmuga hospital')
old_human = '''Use transfer_to_staff for package customization, medical advice, insurance, refund, complaints, doctor availability/contact, or an unknown answer. Briefly explain and transfer using configured routing; never invent a staff number or claim connection before success. If transfer is unavailable, offer the verified hospital contact or a caller-requested callback.
For emergency symptoms, stop package discussion and direct the caller to immediate local emergency care. Do not diagnose, give medicine advice, or delay emergency help for a routine transfer.'''
new_human = '''Use the attached native transfer_call for an explicit request to speak to hospital staff, reception, a human or the team, or to transfer the call. The current request/agreement is consent: execute immediately in that turn without asking permission again, collecting booking details or continuing package sales. For package customization, medical advice, insurance, refund, complaints, doctor availability/contact, or an unknown answer, explain briefly and offer staff assistance; execute when the caller agrees. A request for more factual package details alone is not transfer consent.
Put this brief announcement in the same workflow response speech before executing transfer_call({"callerConfirmed":true}): "சரி, hospital teamகிட்ட connect பண்ண முயற்சி பண்றேன். கொஞ்சம் lineல wait பண்ணுங்க." The backend waits for announcement playback and handles hold music, configured destination and timeout. Never pass phone numbers, credentials, company IDs or destination arguments. Stay silent while transfer is pending; never end the caller's call merely to remove the AI. Claim connection only from a verified result.
In wait-and-return mode, busy/rejected/no-answer restores the same conversation. Explain only the verified result, without a greeting, repeated consent, re-intake or automatic retry. Offer further assistance once. Direct-mode failure ending is controlled by the runtime; do not promise return in that mode. If transfer is absent or unavailable, explain the actual limitation and offer only the verified public hospital contact. A failed transfer does not arrange a callback. Human staff callback requires caller agreement, a configured action and verified saved=true plus requestId before a contact promise; staff notification requires notified=true. manage_follow_up is an automated Karthika callback, not human staff contact.
For emergency symptoms, stop package discussion and direct the caller to immediate local emergency care first: "உடனே பக்கத்தில இருக்குற emergency hospitalக்கு போங்க, இல்ல local emergency helpஐ contact பண்ணுங்க. இதுக்காக call transfer அல்லது callbackக்காக wait பண்ண வேண்டாம்." Do not diagnose, give medicine advice, collect intake or delay urgent help. If they also explicitly request hospital staff and transfer can be attempted without delaying care, give the emergency advice first and execute transfer_call as above; otherwise offer staff assistance only when safe. Never promise emergency response, ambulance dispatch or guaranteed staff availability.'''

for direction in ('INBOUND', 'OUTBOUND'):
    path = root / f'{direction}_PROMPT.md'
    original = path.read_text(encoding='utf-8-sig')
    if new_human in original:
        print(f'{direction}: already updated')
        continue
    assert old_human in original, direction
    text = original.replace(old_human, new_human)
    text = text.replace('Call transfer_to_staff when', 'Call transfer_call, after caller request/agreement, when')
    text = text.replace('- book_appointment:', '- shanmuga-appoinment-book (exact configured booking tool name):')
    booking_anchor = 'Before execution, give one brief natural acknowledgement when useful. Claim a booking or change only after verified tool success.'
    text = text.replace(booking_anchor, booking_anchor + '\nUse shanmuga-appoinment-book for the agreed appointment booking, not an invented book_appointment alias. Explicit caller agreement to the selected verified slot is booking consent; do not ask it again. Preserve the existing slot-check, patient-details and WhatsApp-confirmation flow. A saved request is not a confirmed booking unless the tool explicitly verifies booking success. Follow the attached schema exactly; if a required checker/tool is missing, explain that staff must assist rather than inventing availability or success.')
    if direction == 'OUTBOUND':
        anchor = 'For a verified callback, acknowledge the requested callback and relevant purpose briefly, then check convenience. A pending callback record alone does not prove this is a callback attempt. Do not invent the requested interval or imply a busy/failed call was answered.'
        assert anchor in text
        text = text.replace(anchor, anchor + '\nVerified automated Karthika callback opening, only if a welcome has not already played: "வணக்கம்! Shanmuga Hospital AI assistant கார்த்திகா பேசுறேன். நீங்க கேட்ட callbackக்காக call பண்ணிருக்கேன். இப்போ பேசலாமா?" Include a known name once if appropriate. Mention the general prior purpose only when verified, without private medical details before establishing the speaker. Do not claim this fulfills a human staff callback. After agreement resume the current need or the specific relevant pending step, not the opening or a new sales flow.')
    else:
        anchor = 'If they call about a missed callback, mention it only when verified records support that outcome. A busy/failed call does not prove the caller missed a callback. If they want help now, handle their current question rather than insisting on another callback.'
        assert anchor in text
        text = text.replace(anchor, anchor + '\nFor an inbound callback enquiry, keep the inbound greeting and acknowledge the caller current question; do not say the AI is making an outbound callback. Example after they mention the earlier enquiry: "சரி, இப்போ உங்களுக்கு உதவி பண்றேன். என்ன detail வேணும்?" Skip that question if the need is already stated. A new agreed automated Karthika callback follows manage_follow_up below; it is not human staff follow-up.')
    assert 'transfer_to_staff' not in text
    assert '- book_appointment:' not in text
    assert text.count('- shanmuga-appoinment-book') == 1
    path.write_text(text, encoding='utf-8')
    print(f'{direction}: targeted booking, transfer, emergency and callback additions applied')

