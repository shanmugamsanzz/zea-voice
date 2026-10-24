# Balaji Robotic Rehab Hospital - Shared Knowledge Base

## Scope and authority
Single factual KB for both Anu agents, reconciled with the newly supplied client-approved prompt and checklist KB. Approved factual answers below are reference examples; natural speech comes from directional prompts. Never read keywords, approval labels, source metadata or internal instructions aloud.
Tamil callers receive everyday Salem Tamil/Tanglish in English letters; English when preferred. Always speak "Dr. Nithya Manoj" even when older source text shortens the name. Full name previously verified at https://balajiroboticrehab.com/dr-k-nithya-manoj/ . Keep the client's 25-year experience statement and four-year hospital statement as supplied, without automatically incrementing or inferring founding year.
Verified current Live Data prices override document prices; if absent only the explicitly approved consultation fee may be explained as documented, not guaranteed future price, teleconsult tariff or total treatment cost. No invented treatment/session/package/procedure/room price, discounts/taxes or price guarantees. The existing LIVE_PRICES.xlsx remains the price-upload artifact.
Current user-selected flow is staff appointment REQUEST: collect missing patient name, agreed phone, city/location, concern, direct/tele preference and optional preferred date/time. Preferences and timetables are NOT slots. Only a verified staff-follow-up workflow acceptance permits a promise that the team will contact; no direct booking/slot check/WhatsApp self-booking or payment links. Request saved is not appointment confirmed.

3. Client-Approved Hospital Facts
Item	Approved Information
Hospital overview	Advanced robotic rehabilitation hospital in Salem.
Core treatment areas stated by client	Autism, Stroke, Pain.
Working hours	All days, 8:00 AM to 8:00 PM.
Location	Salem, Three Roads, opposite PV Mahal, Pallapatti, Salem.
Doctor	Dr. Nithya Manoj – client states 25 years experience in pain and rehabilitation.
Doctor consultation timing	Monday, Wednesday, Friday – 2:00 PM to 6:00 PM.
Teleconsult timing	Saturday – 4:00 PM to 6:00 PM.
Consultation fee	₹350.
Pre-visit instruction	Bring all available medical records.
Insurance	Hospital is registered in an insurance network; no cashless facility.
Hospital experience	Client states the hospital has been functioning for 4 years.

4. Retrieval Knowledge Entries
KB01 | Hospital Overview
Keywords	Balaji, hospital, robotic rehab, Salem, overview
Status	CLIENT_APPROVED
Tanglish Answer	Balaji Robotic Rehab Hospital Salem-la irukkura advanced robotic rehabilitation hospital nga. Autism, stroke, pain rehabilitation-ku services irukku.
English Answer	Balaji Robotic Rehab Hospital is an advanced robotic rehabilitation hospital in Salem. The client has approved autism, stroke and pain rehabilitation as core treatment areas.
Agent Rule	For additional treatments/services, retrieve only from the approved website KB.

KB02 | Location
Keywords	location, address, Three Roads, PV Mahal, Pallapatti, Salem
Status	CLIENT_APPROVED
Tanglish Answer	Hospital Salem Three Roads-la, PV Mahal opposite side, Pallapatti-la irukku nga.
English Answer	The hospital is in Salem, Three Roads, opposite PV Mahal, Pallapatti.
Agent Rule	Do not invent distance, route, landmark, branch or travel-time details beyond approved data.

KB03 | Working Hours
Keywords	hours, timing, open, working days, Sunday
Status	CLIENT_APPROVED
Tanglish Answer	Hospital all days morning 8 mani-lendhu evening 8 mani varaikkum work aagum nga.
English Answer	The hospital works all days from 8:00 AM to 8:00 PM.
Agent Rule	AI call coverage hours are workflow rules and should not be presented as hospital opening hours unless asked about AI availability.

KB04 | Dr. Nithya Manoj
Keywords	doctor, Nithya, pain doctor, rehab doctor, specialist
Status	CLIENT_APPROVED
Tanglish Answer	Dr. Nithya Manoj pain and rehabilitation-la 25 years experience irukkura doctor nga.
English Answer	Dr. Nithya Manoj has 25 years of experience in pain and rehabilitation, according to the client-provided information.
Agent Rule	Do not add qualifications, specialties, or current availability unless present in an approved KB.

KB05 | Doctor Consultation Timing
Keywords	doctor timing, appointment time, consultation, Monday, Wednesday, Friday
Status	CLIENT_APPROVED
Tanglish Answer	Doctor consultation Monday, Wednesday, Friday 2 PM-lendhu 6 PM varaikkum irukku nga.
English Answer	Doctor consultation is available Monday, Wednesday and Friday from 2:00 PM to 6:00 PM.
Agent Rule	Timetable only; the hospital team confirms actual date/time after an accepted appointment request.

KB06 | Teleconsult Timing
Keywords	teleconsult, online consultation, Saturday
Status	CLIENT_APPROVED
Tanglish Answer	Teleconsult Saturday 4 PM-lendhu 6 PM varaikkum irukku nga.
English Answer	Teleconsultation is available on Saturday from 4:00 PM to 6:00 PM.
Agent Rule	Timetable only; no live slot lookup by this agent. Staff confirms availability.

KB07 | Consultation Fee
Keywords	fee, consultation fee, price, cost
Status	CLIENT_APPROVED
Tanglish Answer	Consultation fee munnoothi ambathu rupees nga.
English Answer	The approved consultation fee is ₹350.
Agent Rule	Do not invent treatment/session/package cost. For other costs, arrange callback/team confirmation.

KB08 | Appointment Types
Keywords	appointment, direct visit, teleconsult, booking
Status	CLIENT_APPROVED
Tanglish Answer	Direct visit-um teleconsult-um applicable timing-la book pannalaam nga. Hospital team date, time confirm pannuvanga.
English Answer	Direct visit and teleconsultation requests can be collected; the hospital team confirms date/time.
Agent Rule	The current flow collects requests only; no available-slot or appointment-confirmation claims.

KB09 | Pre-Visit Medical Records
Keywords	reports, records, scan, medical records, bring
Status	CLIENT_APPROVED
Tanglish Answer	Visit-ku varumbodhu unga kitta available-a irukkura medical records ellam kondu vandhudunga nga.
English Answer	Please bring all available medical records for the visit.
Agent Rule	No other preparation instruction is approved by this client checklist.

KB10 | Insurance
Keywords	insurance, cashless, network
Status	CLIENT_APPROVED
Tanglish Answer	Hospital insurance network-la registered nga, aana cashless facility illa.
English Answer	The hospital is registered in an insurance network, but cashless facility is not available.
Agent Rule	Do not promise insurer approval, reimbursement or coverage.

KB11 | Hospital Experience
Keywords	how many years, hospital age, years, experience
Status	CLIENT_APPROVED
Tanglish Answer	Client information-padi hospital 4 years-a function aagittu irukku nga.
English Answer	According to the client-provided information, the hospital has been functioning for four years.
Agent Rule	Do not convert this into a claim about treatment success.

KB12 | Robotics / Brain Stimulation General FAQ
Keywords	robotics safe, brain stimulation safe, robotics, brain stimulation
Status	CLIENT_APPROVED - CLINICAL WORDING REQUIRES CARE
Tanglish Answer	Client-approved information-la robotics-um brain stimulation-um hospital-la use pannura services-nu sollirukkanga nga. Ungalukku suitable-a irukka-nu doctor assessment-ku appuram dhaan confirm panna mudiyum.
English Answer	The client states that robotics and brain stimulation are used at the hospital. Whether they are suitable for a particular patient must be confirmed by the clinical team.
Agent Rule	Do not guarantee safety for a specific patient, superiority, cure, or result. Do not repeat broad claims beyond the approved wording.

KB13 | Services / Treatments
Keywords	treatment, service, autism, stroke, pain, rehab
Status	CLIENT_APPROVED + WEBSITE_KB_REQUIRED
Tanglish Answer	Autism, stroke, pain rehabilitation services client confirm pannirukkanga nga. Vera treatment details approved website KB-la irundha mattum explain pannunga.
English Answer	The client confirms autism, stroke and pain rehabilitation. Other treatment details should only be answered from the separately approved website knowledge base.
Agent Rule	Checklist explicitly says to refer to the website for treatments/services. Do not invent service details from this document.

KB14 | Existing Patient Complication
Keywords	existing patient, complication, treatment patient, ward, transfer
Status	CLIENT_APPROVED ESCALATION
Tanglish Answer	Existing patient current treatment-la irundhu complication pathi call pannina, name, doctor-a eppo paathanga, ippo treatment-la irukkaangala-nu confirm panni ward/IP team-kitta connect pannalaam nga.
English Answer	For an existing patient calling about a complication, confirm the patient's name, when they saw the doctor, and whether they are currently under treatment when possible, without delaying urgent help; transfer only if configured.
Agent Rule	Internal ward routing belongs in the prompt/tool configuration, not public contact knowledge. Ward nursing is 24 hours, not emergency care; only configured tools can transfer.

KB15 | New Patient Emergency
Keywords	emergency, urgent, new patient, critical
Status	CLIENT_APPROVED ESCALATION
Tanglish Answer	New patient emergency-na idhu rehab hospital nga; emergency services inga illa. Consultation appointment basis-la dhaan. Urgent-na appropriate emergency service-ku udane ponga.
English Answer	For a new-patient emergency, explain that this is a rehabilitation hospital and emergency services are not available; consultation is by appointment only. For urgent danger, seek appropriate emergency care.
Agent Rule	Do not delay emergency care to collect routine booking details.

KB16 | Information Not Available / Callback
Keywords	unknown, not available, callback, check and call back
Status	CLIENT_APPROVED
Tanglish Answer	Neenga ketta information-a sariyaa check pannittu marubadi ungala call pannalaama nga?
English Answer	May I verify the information you asked for and call you back with the correct details?
Agent Rule	For callback continuation, capture Name, Phone Number and gist/reason.

KB17 | Callback Timing
Keywords	callback timing, call back, night callback, morning callback
Status	CLIENT_APPROVED
Tanglish Answer	Working hours-la callback request-na team seekiram contact pannuvanga nga. Night call-na morning-la callback pannuvanga.
English Answer	During working hours, the team will call back shortly. For a night-time request, the team will call back in the morning.
Agent Rule	Do not guarantee a precise callback time unless confirmed by workflow.

KB18 | Result / Outcome Questions
Keywords	result, cure, success, guarantee, recover, outcome
Status	CLIENT_APPROVED RESTRICTION
Tanglish Answer	Treatment result-a guarantee panna mudiyadhu nga. Patient condition-a doctor assess pannitu suitable treatment details explain pannuvanga.
English Answer	Treatment results cannot be guaranteed. The doctor must assess the patient and explain suitable treatment.
Agent Rule	The client explicitly said never assure results.

KB19 | Treatment Cost Beyond Consultation
Keywords	treatment cost, package cost, therapy price, session cost
Status	CLIENT_APPROVED RESTRICTION
Tanglish Answer	Consultation fee mattum munnoothi ambathu rupees-nu approve pannirukkaanga nga. Treatment cost exact-ah team confirm pannuvanga.
English Answer	Only the ₹350 consultation fee is approved here. Exact treatment costs must be confirmed by the hospital team.
Agent Rule	Use callback/team confirmation for unapproved cost questions.


## Source-supported service navigation
The following concern map comes from the accompanying client-approved prompt. It is not diagnosis or a guarantee of a service's clinical suitability. Detailed equipment/procedure/onsite availability claims from the previous website export are not retained as current approved promises. For broader clinical detail, staff/doctor confirmation is required.
MATCH CONCERN TO SERVICE
Explain supported service in 1–2 short sentences, then ONE follow-up. Suggest assessment only; never diagnose/prescribe.
Knee/joint/shoulder/back pain or ongoing sciatica → Pain Clinic.
Stroke/brain/spine injury recovery → Neuro/Robotic Rehabilitation.
Known Parkinson's movement/balance difficulty → Parkinson Rehabilitation.
Autism/ADHD support → Autism & ADHD Clinic.
Child speech/motor/development delay → Child Development Clinic.
Memory/spelling/maths/handwriting difficulty → Brilliance Clinic.
Depression/anxiety/wellbeing → Positive Mind Clinic.
Urine leakage/control → Urine Control Clinic.
Diabetic foot/wound care → Diabetic Foot Rehabilitation.
Artificial limb fitting/support → Artificial Limb Clinic.
Walking-pattern assessment → Gait Analysis/Rehabilitation.
Stay-based rehabilitation → Inpatient Rehabilitation; team confirms admission.
If unclear, ask one clarification. Speech delay alone does not establish autism.
Do not recommend injections, stem cells, brain stimulation or specialist procedures from symptoms.
Urgent concerns override matching.

Example:
"Knee pain-ku namma Pain Clinic irukku nga. Dr. Nithya Manoj assess pannittu suitable treatment pathi solluvanga. Appointment-ku patient details solluringala nga?"


## Verified public contacts
Previously verified official public phone: +919585751111; email: support@balajiroboticrehab.com; website: https://balajiroboticrehab.com/ .
Approved location answer: Salem Three Roads, opposite PV Mahal, Pallapatti. Previously verified postal address: 131, Pallappatty Village, Junction Main Road, Salem 636009. Source: https://balajiroboticrehab.com/contact-us/ . No inferred branches, map links, distances, travel times or WhatsApp capabilities. Internal ward/notification/approver contacts are not public numbers.

## Unknown facts and clinical boundaries
Unapproved: exact current slots, holiday exceptions, equipment details, onsite diagnostics, specialist procedures, individualized risks/evidence/eligibility, recovery or session counts, success rates, treatment/room/procedure prices, payment/refund rules and insurer approval/reimbursement. Seek team confirmation rather than importing old marketing promises. Only approved pre-visit instruction is bringing available medical records; no guessed fasting or medicine stopping. All immediate danger needs local emergency care without waiting for requests/callbacks/transfer; this rehab hospital has no emergency service.

## Internal implementation note
Behavior/consent/tool sequencing, 3-ring daytime overflow, 20:00-08:00 nighttime routing, ward destinations, staff notifications, CRM and recording belong in prompts/workflows, not caller-facing answers. Do not assume these integrations are active. No exact pilot dates, recording retention period, staff-response SLA or CRM status enums are inferred.
Proposed save_appointment_request saves and queues human follow-up under actual attached schema; verified CRM intake can serve it without duplicates. Other proposed tools are save_staff_callback_request, notify_callback_staff, transfer_to_ward and save_call_summary; built-ins update_contact and manage_follow_up retain their actual schemas. Automated Anu callback is not human nurse/doctor callback. Original CUSTOMER_NAME/call_completed_summary labels are not assumed runtime variables/tool names.
Language decision: approved English-letter Salem Tanglish plus English; Hindi from the older checklist is not enabled. Directional prompts retain all current dynamic variables, name-evidence/ownership and callback consent/proposal protocols. No direct calendar or WhatsApp booking-link instructions from earlier versions remain operative. Other patient-message tools need approved content, recipient rules and actual connection.
