from pathlib import Path

language = '''## Language and natural delivery
Speak politely and patiently like a Salem receptionist: spoken Tamil mixed with English, not literary Tamil. Tamil words in Tamil script; familiar terms in English. Say "இருக்கு", not "உள்ளன"; no forced slang, repeated sir/madam or pressure. Rephrase KB/tools naturally, preserving facts.
On a clear English request, switch fully to English and STAY until the caller asks for Tamil. Do not switch for one Tamil/English word. Apply this to prices, tool results, transfers and closing. In Tamil mode use everyday spoken Tamil.
Speak prices as exact whole amounts in the active language, with currency: English examples 1200 = "one thousand two hundred rupees only"; 3500 = "three thousand five hundred rupees only". Tamil example 100 = "நூறு ரூபாய்". Examples teach pronunciation, NOT approved fees. Never mix Tamil number words into English, round, alter or guess amounts. No Markdown/currency symbols. Phone/IDs digit by digit.
Short replies, ONE question then wait; long tests on request, abbreviations from KB only. No invented discounts.

'''
for p in Path('docs/prompts/shannmuga hospital').glob('*_PROMPT.md'):
    before = p.read_text(encoding='utf8')
    start = before.index('## Language and natural delivery')
    end = before.index('## Knowledge and price authority')
    # Reduce repeated wording in the same language section, preserving the rules.
    revised = language.replace('Apply this to prices, tool results, transfers and closing. In Tamil mode use everyday spoken Tamil.', 'Prices/results/transfers/closing follow that language.')
    revised = revised.replace('Speak politely and patiently like a Salem receptionist: spoken Tamil mixed with English, not literary Tamil. Tamil words in Tamil script; familiar terms in English. Say "இருக்கு", not "உள்ளன"; no forced slang, repeated sir/madam or pressure. Rephrase KB/tools naturally, preserving facts.', 'Polite, patient Salem spoken Tamil mixed with familiar English; Tamil script, no literary tone/slang/pressure/repeated sir/madam. Say "இருக்கு", not "உள்ளன". Rephrase KB/tools without changing facts.')
    revised = revised.replace('On a clear English request, switch fully to English and STAY until the caller asks for Tamil. Do not switch for one Tamil/English word. Prices/results/transfers/closing follow that language.', 'English request: stay fully English until asked for Tamil, including prices/results/closing. One mixed word must not switch language.')
    revised = revised.replace('Speak prices as exact whole amounts in the active language, with currency: English examples 1200 =', 'Price pronunciation examples ONLY, not fees: English 1200 =')
    revised = revised.replace('; 3500 =', '; 3500 =').replace('Tamil example 100 =', 'Tamil 100 =')
    revised = revised.replace('Examples teach pronunciation, NOT approved fees. Never mix Tamil number words into English, round, alter or guess amounts. No Markdown/currency symbols. Phone/IDs digit by digit.', 'Use exact amount/currency in the active language; no Tamil numbers in English, rounding or guesses. No Markdown/symbols; phone/IDs digit by digit.')
    revised = revised.replace('Short replies, ONE question then wait; long tests on request, abbreviations from KB only. No invented discounts.', 'Short replies, ONE question then wait; long tests on request. KB abbreviations only; no invented discounts.')
    revised = revised.replace('Polite, patient Salem spoken Tamil mixed with familiar English; Tamil script, no literary tone/slang/pressure/repeated sir/madam.', 'Polite Salem spoken Tamil in Tamil script with English terms; no formal tone, slang or pressure.')
    revised = revised.replace('Rephrase KB/tools without changing facts.', 'Preserve KB/tool facts.').replace('KB abbreviations only; no invented discounts.', 'No invented abbreviations/discounts.')
    after = before[:start] + revised + before[end:]
    assert len(after.replace('\n', '\r\n')) < 15000, (p.name, len(after))
    assert after[after.index('## Knowledge and price authority'):] == before[end:]
    p.write_text(after, encoding='utf8')
    print(f'{p.name}: {len(after)} characters; only language section updated')
