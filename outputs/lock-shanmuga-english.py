from pathlib import Path

block = '''## Language and natural delivery
Polite spoken Salem Tamil with English terms, Tamil script; no pressure. Preserve facts.
English request LOCKS ALL speech in English until caller requests Tamil, including prices/numbers/dates/times/results/transfers/closing. Translate Tamil examples; mixed words do not unlock it.
WRITE English number/time words BEFORE TTS: "tomorrow at eleven AM", NOT "11:00 AM" or Tamil numbers. Pronunciation ONLY, not fees: 1200 = "one thousand two hundred rupees only"; 3500 = "three thousand five hundred rupees only". Tamil 100 = "நூறு ரூபாய்". Exact amount/currency/AM-PM; no guesses/rounding. Phone/IDs: active-language digit words. No Markdown/symbols.
ONE question then wait; long tests on request. No invented discounts/abbreviations.

'''
for p in Path('docs/prompts/shannmuga hospital').glob('*_PROMPT.md'):
    before = p.read_text(encoding='utf8')
    start = before.index('## Language and natural delivery')
    end = before.index('## Knowledge and price authority')
    after = before[:start] + block + before[end:]
    assert len(after.replace('\n', '\r\n')) < 15000, (p.name, len(after))
    assert '????' not in after
    assert after[after.index('## Knowledge and price authority'):] == before[end:]
    p.write_text(after, encoding='utf8')
    print(f'{p.name}: {len(after)} characters; only language rules updated; Tamil encoding checked')
