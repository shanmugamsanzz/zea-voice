# Balaji Robotic Rehab Hospital - Shared Knowledge Base v2

## Scope
Shared factual reference for Priya inbound and outbound agents. Business facts and approved service navigation belong here; behavior, collection, consent, tool execution and closing belong in directional prompts. Never speak source labels or internal notes. Sources are existing client-approved v1 facts and subsequent user-approved changes; no new website verification was performed for v2. Historical source URLs below document provenance, not newly checked availability.

## Hospital and public contacts
- Name: Balaji Robotic Rehab Hospital, Salem.
- Overview: advanced robotic rehabilitation hospital; client-approved core areas include autism, stroke and pain rehabilitation. The broader clinic map below is also approved reference material.
- Location: Salem, Three Roads, opposite PV Mahal, Pallapatti.
- Previously recorded postal address: 131, Pallappatty Village, Junction Main Road, Salem 636009. Do not infer additional branches or directions.
- Public phone: +919585751111.
- Public email: support@balajiroboticrehab.com.
- Official website: balajiroboticrehab.com . Historical contact source: the contact page on balajiroboticrehab.com . Answer known facts directly; a source URL is not an instruction to send the caller to a website.
- Client states the hospital has operated for four years; do not automatically increment or infer founding year.

## Distinct operating schedules (IST)
| Item | Approved schedule | Meaning |
| --- | --- | --- |
| Hospital opening | Every day, 8 AM to 8 PM | Opening hours only, not proof a particular staff member or doctor is present |
| Standard hospital-team transfer window | Every day, at or after 8 AM and strictly before 8 PM IST | User-approved attempt window; connection requires configured transfer tool and actual result |
| Dr. Nithya Manoj General Consultation | Monday, Wednesday, Friday, 2 PM to 6 PM | Published in-person consultation schedule, not a reserved slot |
| Teleconsultation | Saturday, 4 PM to 6 PM | Remote consultation schedule; does not establish Saturday in-person doctor availability |

A Saturday physical visit enquiry concerns hospital hours and the requested purpose of visit. Hospital opening must not be substituted for a confirmed doctor visit. Saturday in-person doctor or staff availability needs team confirmation. No holiday exceptions or real-time presence information is supplied. Outside the standard transfer window, no immediate standard team-transfer attempt or guaranteed staff callback; prompts define supported alternatives. No 24-hour ward-transfer exception is approved by this v2 setup.

Resolve relative dates from runtime current.datetime in IST before matching the requested weekday to the schedules above. Recurring hours do not prove doctor presence or a bookable slot; date-specific availability requires verified evidence. Next week alone is a range, not a selected date. Never infer Saturday in-person availability from Teleconsultation hours.

## Doctor
Dr. Nithya Manoj: client states 25 years in pain and rehabilitation. Always use the full spoken name. Historical source: the doctor profile page on balajiroboticrehab.com . Do not infer qualifications, current presence or guaranteed availability from the profile.

## Consultation fees
| Service ID | Service | Approved consultation fee |
| --- | --- | --- |
| GENERAL-CONSULTATION | General Consultation | INR 350 |
| TELE-CONSULTATION | Teleconsultation | INR 350 |

Both fees were explicitly approved by the user, including the later correction that Teleconsultation is also paid. Neither is a treatment or session or package or procedure or room price. Current matching numeric Live Data with quote_allowed=true supersedes these document prices. No free-teleconsultation claim, discounts, taxes, payment completion or price guarantee is supplied. Exact treatment cost is confirmed by the clinical or team assessment. LIVE_PRICES.xlsx contains the matching upload rows; it is not a slot calendar and does not synchronize automatically.

## Consultation choice, booking link and payment options
- First offer the choice in everyday language: visiting the hospital in person or speaking with the doctor by phone. In-person means General Consultation; doctor phone or remote consultation means Teleconsultation. An immediate reception or team transfer is a different request.
- Both consultation types have an approved INR 350 consultation fee, subject to current permitted matching Live Data. Explain the selected type and its fee without forcing the caller to choose technical labels.
- User-approved booking process for BOTH types: send the appropriate WhatsApp booking link through the configured consultation action. Caller can book through that link and optionally pay the consultation fee online, OR book only and pay in person. Online payment is optional. Do not invent deadlines, refunds, accepted payment methods or a requirement to pay before a teleconsultation call.
- For Teleconsultation, the user approved the same pay-in-person option; when or how that payment is arranged is not specified. If asked, seek team confirmation without guessing.
- Say a booking link was sent only when the actual tool result verifies sending the booking-link message. A generic details-message result does not establish a booking link. Saved or queued or accepted is not sent.
- Sending the link does not book an appointment, reserve a slot, confirm payment or establish doctor availability. The caller completes booking or payment as applicable; claims of those outcomes require actual verified results.
- Caller name is optional and requested once near the beginning only when not already known (outbound after speaking consent). Appointment-link sending does not collect caller or patient names again: reuse known values and the consultation choice. Trusted recipient rules and exact schemas remain authoritative; if a configured tool requires a missing name, explain the limitation rather than fabricating it or repeating name intake. This KB adds no phone or city or date or time intake, calendar lookup or guaranteed staff follow-up.

## Approved service and concern navigation
Explain supported service in 1–2 short sentences, then ONE follow-up. Suggest assessment only; never diagnose or prescribe.
Knee or joint or shoulder or back pain or ongoing sciatica → Pain Clinic.
Stroke or brain or spine injury recovery → Neuro or Robotic Rehabilitation.
Known Parkinson's movement or balance difficulty → Parkinson Rehabilitation.
Autism or ADHD support → Autism & ADHD Clinic.
Child speech or motor or development delay → Child Development Clinic.
Memory or spelling or maths or handwriting difficulty → Brilliance Clinic.
Depression or anxiety or wellbeing → Positive Mind Clinic.
Urine leakage or control → Urine Control Clinic.
Diabetic foot or wound care → Diabetic Foot Rehabilitation.
Artificial limb fitting or support → Artificial Limb Clinic.
Walking-pattern assessment → Gait Analysis or Rehabilitation.
Stay-based rehabilitation → Inpatient Rehabilitation; team confirms admission.
If unclear, ask one clarification. Speech delay alone does not establish autism.
Do not recommend injections, stem cells, brain stimulation or specialist procedures from symptoms.
Urgent concerns override matching.

Use one or two plain sentences explaining the mapped clinic, assessment and only documented services. Neck or nerve concerns described unclearly need clarification; do not assert a diagnosis. Service matching does not establish patient suitability. Avoid mapping speech delay to autism without an established diagnosis.

## Approved technology information
Client-approved material states robotics and brain stimulation are used at the hospital. This is general information, not a recommendation for a particular patient or a claim that either is suitable, universally safe, superior or guaranteed effective. Specific equipment, procedures and current onsite availability require verified clinical or team information.

## Pre-visit records and insurance
- Bring all available medical records; no other preparation requirement is supplied.
- Hospital is registered in an insurance network; no cashless facility.
- Never promise coverage, insurer approval or reimbursement.
- Do not advise fasting, stopping medication or exercises from this KB.

## Clinical and urgent-help boundaries
No diagnosis, prescription, cure or success guarantee, recovery duration, session count or treatment recommendation can be established from a caller's symptoms. Clinical team assessment determines suitability and treatment details.
This rehabilitation hospital has no emergency service. For immediate danger, seek the nearest appropriate emergency hospital or local emergency assistance (108 where applicable), without waiting for appointment intake, a transfer or callback. Existing-patient treatment complications need prompt human or clinical help through configured routes; they do not automatically mean rebooking or emergency classification.

## Unavailable information and callbacks
Unknown: exact slots, holiday exceptions, staff names or presence, immediate doctor availability, detailed procedures or equipment, diagnostics, admissions, room or treatment or package prices, payment or refund policies, individualized eligibility or clinical risks. Identify only the missing fact, continue answering known facts and use configured help routes. Never assert there is no service or system merely because information is unavailable.
Automated Priya callback and a staff callback are different. No unconditional "team will call shortly" or "morning callback" promise is approved. Claims require consent, a configured action and verified acceptance; exact ring time is not guaranteed. Contact details and previous summaries do not authorize a callback or transfer by themselves.

Reception-window comparison: IST is UTC plus five hours thirty minutes. 8 AM is 08:00 and 8 PM is 20:00. 4:29 PM is 16:29, inside the reception transfer window on every day. Doctor consultation days do not restrict this window; actual connection requires a verified transfer result.
