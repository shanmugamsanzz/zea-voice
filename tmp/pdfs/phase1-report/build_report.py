from pathlib import Path
from html import escape
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from pypdf import PdfReader

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'output/pdf/Zea_Voice_Phase_1_Completion_Report.pdf'
NAVY=HexColor('#15364A'); TEAL=HexColor('#087E83'); GRAY=HexColor('#52616B'); LIGHT=HexColor('#EFF4F7'); LINE=HexColor('#D6E0E5')
styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='BrandSmall',fontName='Helvetica-Bold',fontSize=10,leading=14,textColor=TEAL,spaceAfter=10))
styles.add(ParagraphStyle(name='ReportTitle',fontName='Helvetica-Bold',fontSize=31,leading=36,textColor=NAVY,spaceAfter=16))
styles.add(ParagraphStyle(name='PageTitleCustom',fontName='Helvetica-Bold',fontSize=24,leading=29,textColor=NAVY,spaceAfter=12))
styles.add(ParagraphStyle(name='LeadCustom',fontName='Helvetica',fontSize=11.5,leading=17,textColor=GRAY,spaceAfter=14))
styles.add(ParagraphStyle(name='BodyCustom',fontName='Helvetica',fontSize=10.2,leading=14,textColor=NAVY,spaceAfter=6))
styles.add(ParagraphStyle(name='SectionCustom',fontName='Helvetica-Bold',fontSize=13,leading=18,textColor=NAVY,spaceBefore=12,spaceAfter=7))
styles.add(ParagraphStyle(name='FeatureTitle',fontName='Helvetica-Bold',fontSize=12,leading=16,textColor=NAVY,spaceBefore=9,spaceAfter=4))
styles.add(ParagraphStyle(name='SmallCustom',fontName='Helvetica',fontSize=8.5,leading=12,textColor=GRAY,spaceAfter=6))
styles.add(ParagraphStyle(name='CellCustom',fontName='Helvetica',fontSize=9.2,leading=13,textColor=NAVY))
styles.add(ParagraphStyle(name='CellHead',fontName='Helvetica-Bold',fontSize=9.2,leading=13,textColor=white))
story=[]
def p(text,style='BodyCustom'):
    return Paragraph(text,styles[style])
def add(text,style='BodyCustom'):
    story.append(p(text,style))
def table(headers,rows,widths):
    values=[[p(escape(x),'CellHead') for x in headers]]+[[p(escape(str(x)),'CellCustom') for x in row] for row in rows]
    t=Table(values,colWidths=widths,repeatRows=1,hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6),('LINEBELOW',(0,0),(-1,0),0.5,LINE),('ROWBACKGROUNDS',(0,1),(-1,-1),[white,LIGHT]),('INNERGRID',(0,1),(-1,-1),0.3,LINE),('BOX',(0,0),(-1,-1),0.4,LINE)]))
    story.append(t);story.append(Spacer(1,12))
def page(title,kicker,lead):
    story.append(PageBreak());add(kicker,'BrandSmall');add(title,'PageTitleCustom');add(lead,'LeadCustom')

add('ZEA VOICE  /  DELIVERY REPORT','BrandSmall')
add('Phase 1<br/>Completion Report','ReportTitle')
add('15 core features and available platform options','LeadCustom')
add('Prepared for the project owner and operations team<br/>16 October 2026 | Phase 1 / Beta 1','SmallCustom')
add('Delivery summary','SectionCustom')
add('Phase 1 establishes a multi-company AI voice platform for configuring agents, handling incoming and outgoing calls, answering from company information, executing approved actions, and reviewing call outcomes and usage. The current repository contains the 15 capabilities described in this report.')
add('<b>Delivery position:</b> core implementation is delivered in code. Final production acceptance remains subject to deployment verification, configured integrations and the open items on page 6. This report is a delivery inventory, not a claim that every feature or provider combination has passed live acceptance.')
table(['Area','Recorded position'],[
    ('Product','Zea Voice multi-company AI voice-agent application'),
    ('Core feature inventory','15 implemented capabilities, detailed on pages 2 to 4'),
    ('Business configurations','Balaji Robotic Rehab Hospital, Shanmuga Hospital and New Royal Builders prompt packages'),
    ('Operation channels','Plivo telephone calls and authenticated browser voice testing'),
    ('Review baseline','Current local repository, project documentation and previously recorded local checks'),
    ('Acceptance','Pending owner review of deployed build and open items; no acceptance signature assumed')
],[114,397])
add('What Phase 1 delivers','SectionCustom')
add('A shared platform with company-specific agents, prompts, knowledge and tools. Administrators manage the platform; company developers configure operations; company users review the company records exposed to their account. External booking, WhatsApp and staff callback actions require their own configured integrations.')
add('Reading this report','SectionCustom')
add('Each feature lists the capability and available options. "Implemented" means functionality exists in the repository; it does not certify that a customer has enabled, connected or live-tested every option. No fixed concurrency or provider performance guarantee is implied.','SmallCustom')

features=[
('Company access and role controls','Company and workspace boundaries separate agents, data and operational records. Role permissions distinguish platform administration, company configuration and company review.','Super Admin, Company Developer and Company User; account-specific tab access where enabled.','Role restrictions remain in force even when a tab is visible.'),
('Provider and model administration','Administrators can register provider credentials, models and pricing, while agents select configured AI services. Credential handling is separate from caller-facing prompts.','STT, text LLM and TTS selection; compatible audio-to-audio adapters exist in the registry.','Only active, connected and runtime-compatible models are usable; provider plans impose their own limits.'),
('Agent creation and conversation settings','Create company-owned agents with their identity, instructions, language/voice choices, greetings and operational settings. Direction-specific prompt packages support inbound and outbound behavior.','Master prompt, welcome behavior, voice/model choices, interruption and silence settings, memory policy, tools and post-call options.','A saved prompt does not create an external integration or guarantee model compliance.'),
('Inbound and outbound telephony','Plivo call handling connects configured company numbers and agents to the real-time voice runtime. Signed callbacks and authenticated media support call lifecycle events.','Inbound number routing, outbound calling, call status tracking and configured recording behavior.','A completed telephone call and a successful business outcome are separate statuses.'),
('Browser testing and controlled calling access','Authenticated browser voice tests exercise the shared conversation runtime before telephone rollout. Secure calling links provide restricted access to a selected agent where enabled.','Browser microphone/audio tests; authorized phone tests; 24-hour or revocable permanent phone-test share links.','Browser tests do not prove live Plivo bridging, carrier behavior or external provider concurrency.'),
('Company knowledge management','Agent-owned knowledge supports approved facts, services, policies and FAQs. Questions are matched to relevant indexed content.','Document assignment, retrieval scope and grounded-answer source records; shared business KBs and directional prompts.','Retrieval supplies candidate evidence; source presence alone does not verify every generated claim.'),
('Live Data tables for changing information','Live Data holds current prices, inventory and availability. Search identifies matching tables; PostgreSQL supplies their current rows.','Custom columns and rows, table indexing, current values and table-level Answer sources.','Current limits are up to two selected tables and 500 rows per table. Ranked retrieval is not guaranteed catalogue-wide coverage.'),
('Authorized tools and external workflows','Assigned actions perform business tasks. Tool schemas and actual results govern what the agent may claim to the caller.','Configured booking/request tools, WhatsApp actions, webhooks, pre-call context and post-call delivery integrations.','External actions must be connected for each company. A saved request, sent message and confirmed booking are different outcomes.'),
('Native staff call transfer','The built-in transfer action uses agent-specific approved destinations and company-owned Plivo credentials. Staff answering bridges the caller; wait-mode failure can restore the existing AI conversation.','Direct or wait-and-return mode; ring timeout, announcement, hold music and optional configured staff follow-up.','Native transfer is controlled by the global feature switch and agent settings. Latest live logs show a staff bridge; announcement audibility still needs acceptance.'),
('Automated callbacks and reminders','Consent-based follow-up scheduling supports returning to an unfinished enquiry at a requested time. Backend time resolves relative callbacks; absolute proposals require confirmation.','Relative callbacks, absolute date/time callbacks, requested reminders and cancellation through manage_follow_up.','An automated agent callback is not a human staff callback. No exact ring-time guarantee.'),
('Campaign and batch calling operations','Company campaign workflows organize authorized outbound contacts, imported leads, scheduled tasks and operational retries. Campaign controls provide a managed alternative to manual repeated dialing.','Lead import and duplicate handling, campaign start/pause controls, schedules, retries and guarded deletion.','Accepted unique leads differ from file row counts. Campaign eligibility still depends on schedule, credits and provider limits.'),
('Shared capacity and call queues','Company-level admission coordinates shared inbound/outbound capacity and waiting work. Queue monitoring and management support controlled dispatch rather than unrestricted parallel calling.','Company/campaign concurrency settings, waiting limits, queue views and authorized task controls; rollout-dependent inbound waiting.','Configured capacity is not a tested throughput guarantee. Provider quotas and infrastructure must be validated with staged load tests.'),
('Conversation memory and contact continuity','Supplied call history, summaries and workflow state help agents retain context and avoid re-asking known information. The authorized contact tool supports caller-own name corrections.','Current-call memory, recent-turn/full-current-call settings, returning-call context and update_contact ownership checks.','History windows are bounded. Prompt instructions cannot create permanent state or guarantee retention beyond configured limits.'),
('Reports transcripts and post-call intelligence','Operational views expose call records, transcripts and configured recordings. Post-call processing uses a selected summary LLM to produce a structured summary, outcome, sentiment and follow-up fields.','Summary model/instructions, webhook payload options, developer Answer sources, provider diagnostics and selected-call request/response/playback tracing.','Normally one stored AI summary per call; failed jobs may retry. Recording/source availability depends on the actual call configuration and saved events.'),
('Metered usage pricing and company credits','Provider usage events record LLM tokens, speech usage and telephony measures. Configured price versions and exchange rates support call-cost breakdowns and company credit accounting.','Provider/model pricing, exchange rates, wallets, credit ledger, admission checks and developer cost reports.','Known gap: summary usage/cost is recorded after call credit finalization without an additional summary-credit adjustment. See page 6.')
]
for group,(title,lead) in enumerate([
 ('Agent setup and calling','Core features 01 to 05 | Administration, configuration and access to voice channels.'),
 ('Knowledge and business automation','Core features 06 to 10 | Company facts, current data, authorized actions and follow-up.'),
 ('Operations continuity and visibility','Core features 11 to 15 | Outbound execution, memory, reporting and financial visibility.')
]):
    page(title,'PHASE 1  /  CORE FEATURES',lead)
    for index in range(group*5,group*5+5):
        name,desc,options,condition=features[index]
        story.append(KeepTogether([p(f'{index+1:02d}  {name}','FeatureTitle'),p(desc),p('<b>Available options:</b> '+options),p('<b>Condition:</b> '+condition,'SmallCustom')]))

page('Available platform options','PHASE 1  /  OPERATING OPTIONS','Configuration flexibility is available within role permissions, active integrations and runtime compatibility.')
table(['Role','Primary available operations'],[
 ('Super Admin','Manage companies, accounts, provider/model configuration, platform pricing and credits; work within authorized company context.'),
 ('Company Developer','Configure company agents, resources, integrations and operational campaigns; inspect developer diagnostics where access is enabled.'),
 ('Company User','Review company-scoped operational records and dashboards exposed to the account; no general configuration-management authority.')
],[125,386])
add('Configuration choices','SectionCustom')
table(['Option group','Available choices'],[
 ('Conversation','Inbound/outbound identity and purpose; company-specific prompt; welcome; caller language preference and voice behavior.'),
 ('AI services','Select active supported STT, LLM and TTS; adapter-based audio-to-audio support subject to compatible runtime/model setup.'),
 ('Knowledge','Approved text knowledge plus structured Live Data; company/agent scoped retrieval and source reporting.'),
 ('Actions','Company-assigned webhooks; request/booking workflows; approved WhatsApp sharing; native transfer modes and callback actions.'),
 ('Follow-up','Automated callback/reminder timing and cancellation; returning-call context; separate human callback workflow if configured.'),
 ('Operations','Campaign schedule, concurrency, waiting limits, retries and queue controls; secure calling links where enabled.'),
 ('Post-call','Summary enablement/model/instructions, configured transcript/summary/phone webhook fields, recording and diagnostic access.')
],[125,386])
add('Business configuration packages','SectionCustom')
add('<b>Balaji:</b> rehabilitation enquiries, consultation requests and staff assistance. <b>Shanmuga:</b> health check-up information, booking workflow and staff routing. <b>New Royal Builders:</b> project/plot enquiries, Live Data inventory, agreed site visits and sales-team assistance.')
add('These packages are prompt/configuration assets. External booking, WhatsApp and staff callback connections are not certified by the existence of a prompt. The same platform can support other companies through authorized configuration.','SmallCustom')

page('Completion and acceptance record','PHASE 1  /  HANDOVER','Core delivery is documented. The items below distinguish recorded evidence from outstanding production acceptance.')
add('Recorded verification','SectionCustom')
add('Previously recorded local checks passed: the 14-check call-transfer release suite, covering transfer settings, playback acknowledgements, return behavior, tools, callbacks, capacity, browser regressions and normal hangup handling. Five relevant Live Data/source-reporting checks also passed during the source propagation fix. These results were recorded earlier in this work session, not rerun for this PDF.')
add('A supplied live-call log shows transfer progressing from requested to ringing to bridged. It supports successful staff connection for that call; it does not independently prove announcement audibility or every transfer failure scenario. No new paid call, deployment, load test or database migration was performed for this report.','SmallCustom')
table(['Outstanding item','Required completion evidence'],[
 ('Summary credit reconciliation','Implement and verify an idempotent additional credit charge/adjustment for post-call summary usage; reconcile cost report and ledger.'),
 ('Live Data follow-ups','Validate catalogue coverage and short follow-up queries. Independent/bounded Live Data inclusion and durable project selection remain proposed improvements.'),
 ('Language and number speech','Verify English language persistence and spoken number/time words with actual TTS. Cartesia currently uses configured synthesis language; prompt-only language switching is not full runtime switching.'),
 ('Transfer audio acceptance','Confirm the announcement is heard before transfer and hold music starts acceptably; correlate recording, TTS text and playback checkpoints.'),
 ('Deployment and load acceptance','Record deployed commit, migrations, enabled flags, connected workflows, provider limits, approved concurrency, rollback and business-user acceptance.')
],[144,367])
add('Completion decision','SectionCustom')
add('<b>Implementation:</b> 15 core capabilities present. <b>Deployment revision:</b> not established for this report. <b>Business acceptance:</b> pending owner confirmation. Phase 1 can be handed over for controlled acceptance testing; unresolved billing and live-behavior issues must not be represented as closed.')
add('Evidence references','SectionCustom')
add('Repository reviewed: README.md; outputs/testing-handover-beta1/build.mjs; docs/call-queue-release.md; docs/phone-test-share-links.md; docs/follow-up-scheduling.md; docs/CALL_TRANSFER_SETTINGS.md; docs/LLM_REQUEST_TRACING.md. Current code reviewed includes provider registration, Qdrant/Live Data retrieval, post-call summary metering and call-credit finalization. Older architecture notes were treated as background where they differ from current code.','SmallCustom')
add('Prepared from repository evidence and the current development record on 16 October 2026. No production credentials, customer medical data or internal staff telephone numbers are included.','SmallCustom')

class NumberedCanvas(canvas.Canvas):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);self.saved=[]
    def showPage(self):
        self.saved.append(dict(self.__dict__));self._startPage()
    def save(self):
        total=len(self.saved)
        for state in self.saved:
            self.__dict__.update(state)
            self.setStrokeColor(LINE);self.setLineWidth(.6);self.line(42,43,A4[0]-42,43)
            self.setFont('Helvetica',8);self.setFillColor(GRAY)
            self.drawString(42,29,'Zea Voice | Phase 1 delivery | 16 October 2026')
            self.drawRightString(A4[0]-42,29,f'{self._pageNumber} / {total}')
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

doc=SimpleDocTemplate(str(OUT),pagesize=A4,rightMargin=42,leftMargin=42,topMargin=43,bottomMargin=57,title='Zea Voice Phase 1 Completion Report',author='Zea Voice Development Team',subject='15 core features, available options and completion status')
doc.build(story,canvasmaker=NumberedCanvas)
reader=PdfReader(OUT)
assert len(reader.pages)==6,f'Unexpected pagination: {len(reader.pages)}'
text='\n'.join(page.extract_text() for page in reader.pages)
assert all(name in text for name,_,_,_ in features)
assert 'Summary credit reconciliation' in text
print(f'{OUT}\nPages: {len(reader.pages)} | Features verified: {len(features)}')
