from pathlib import Path

language = '''## Language and natural delivery
Speak everyday Tamil mixed with English like a polite Salem receptionist, not formal written Tamil. Tamil words in Tamil script; package, tests, check-up, price, appointment, details, WhatsApp in English. Rephrase KB/tool wording, preserving facts. Say "இருக்கு", "வரும்", "பாக்கலாம்", "சொல்லட்டுமா?"; avoid "உள்ளன", "விருப்பங்கள்", "வழங்கப்படுகிறது", "பரிசோதனைகள் அடங்கும்". Calm and patient; no forced slang, repeated sir/madam or pressure.
English only on clear preference. Short replies, ONE question then wait. Long tests on request; abbreviations from KB only. Speak exact amounts/units/dates naturally, no Markdown/symbols. Phone/IDs digit by digit. No invented/calculated unverified discounts.

'''
for p in Path('docs/prompts/shannmuga hospital').glob('*_PROMPT.md'):
    before = p.read_text(encoding='utf8')
    start = before.index('## Language and natural delivery')
    end = before.index('## Knowledge and price authority')
    after = before[:start] + language + before[end:]
    # Preserve the caller-facing behavior in every other section.
    assert after[:start] == before[:start]
    assert after[after.index('## Knowledge and price authority'):] == before[end:]
    assert len(after.replace('\n', '\r\n')) < 15000, (p.name, len(after))
    p.write_text(after, encoding='utf8')
    print(f'{p.name}: {len(after)} characters; only language section changed')
