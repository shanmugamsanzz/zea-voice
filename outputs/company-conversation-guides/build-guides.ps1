$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression.FileSystem
$out = $PSScriptRoot
$qa = Join-Path $out 'qa'
New-Item -ItemType Directory -Force $qa | Out-Null
function E($s) { [System.Security.SecurityElement]::Escape([string]$s) }
function P($s, $style='Normal') { '<w:p><w:pPr><w:pStyle w:val="'+$style+'"/></w:pPr><w:r><w:t xml:space="preserve">'+(E $s)+'</w:t></w:r></w:p>' }
function Heading($s) { P $s 'Heading1' }
function PageBreak { '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' }
function Table($rows) {
  $s='<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>'
  foreach($b in @('top','left','bottom','right','insideH','insideV')) { $s+='<w:'+$b+' w:val="single" w:sz="5" w:color="D9D9D9"/>' }
  $s+='</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="2800"/><w:gridCol w:w="6560"/></w:tblGrid>'
  $i=0
  foreach($row in $rows) {
    $s+='<w:tr><w:trPr><w:cantSplit/>'+$(if($i -eq 0){'<w:tblHeader/>'})+'</w:trPr>'
    for($j=0;$j -lt 2;$j++) {
      $fill=if($i -eq 0){'DDEAF3'}elseif($i%2 -eq 0){'F4F6F8'}else{'FFFFFF'}
      $s+='<w:tc><w:tcPr><w:tcW w:w="'+@(2800,6560)[$j]+'" w:type="dxa"/><w:shd w:fill="'+$fill+'"/><w:vAlign w:val="center"/></w:tcPr>'+(P $row[$j] 'TableText')+'</w:tc>'
    }
    $s+='</w:tr>'; $i++
  }
  $s+'</w:tbl>'
}
function Diagram($name,$boxes,$arrows) {
  $bmp=New-Object System.Drawing.Bitmap 1200,1150
  $g=[System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::White)
  $g.SmoothingMode='AntiAlias'
  $font=New-Object System.Drawing.Font 'Arial',19
  $small=New-Object System.Drawing.Font 'Arial',15
  $fmt=New-Object System.Drawing.StringFormat; $fmt.Alignment='Center'; $fmt.LineAlignment='Center'
  $pen=New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#50677C')),2
  $pen.CustomEndCap=New-Object System.Drawing.Drawing2D.AdjustableArrowCap 5,6
  $svg='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1150" viewBox="0 0 1200 1150"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#50677C"/></marker></defs><rect width="1200" height="1150" fill="white"/>'
  foreach($a in $arrows) {
    $g.DrawLine($pen,[int]$a[0],[int]$a[1],[int]$a[2],[int]$a[3])
    $svg+='<line x1="'+$a[0]+'" y1="'+$a[1]+'" x2="'+$a[2]+'" y2="'+$a[3]+'" stroke="#50677C" stroke-width="2" marker-end="url(#arrow)"/>'
  }
  foreach($b in $boxes) {
    $x=[int]$b[0];$y=[int]$b[1];$w=[int]$b[2];$h=[int]$b[3];$text=$b[4];$color=$b[5]
    $brush=New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($color))
    $g.FillRectangle($brush,$x,$y,$w,$h)
    $border=New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#50677C')),1
    $g.DrawRectangle($border,$x,$y,$w,$h)
    $drawFont=if($w -lt 300){New-Object System.Drawing.Font 'Arial',14}else{$font}; $g.DrawString($text,$drawFont,[System.Drawing.Brushes]::Black,[System.Drawing.RectangleF]::new($x+12,$y+6,$w-24,$h-12),$fmt)
    $svg+='<rect x="'+$x+'" y="'+$y+'" width="'+$w+'" height="'+$h+'" rx="12" fill="'+$color+'" stroke="#50677C"/>'
    $lines=$text.Split("`n"); $lineStep=if($w -lt 300){22}else{30}; $svgFont=if($w -lt 300){18}else{25}; $ty=$y+$h/2-($lines.Count-1)*$lineStep/2
    foreach($line in $lines) { $svg+='<text x="'+($x+$w/2)+'" y="'+$ty+'" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="'+$svgFont+'" fill="#172B3A">'+(E $line)+'</text>'; $ty+=$lineStep }
    $brush.Dispose();$border.Dispose()
  }
  $svg+='</svg>'
  [IO.File]::WriteAllText((Join-Path $out "$name.svg"),$svg)
  $bmp.Save((Join-Path $qa "$name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose();$bmp.Dispose();$font.Dispose();$small.Dispose();$pen.Dispose()
}
function MakeDoc($name,$title,$intro,$flowtext,$tools,$rules,$sources) {
  $dir=Join-Path $qa $name
  New-Item -ItemType Directory -Force "$dir/_rels","$dir/word/_rels","$dir/word/media" | Out-Null
  Copy-Item "$qa/$name.png" "$dir/word/media/flow.png" -Force
  $body=(P $title 'Title')+(P 'Conversation flows and tool reference' 'Subtitle')+(P $intro)+(Heading 'Conversation flow')
  $body+='<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="5943600" cy="5695950"/><wp:docPr id="1" name="Conversation flow" descr="Inbound and outbound call flow with appointment and assistance branches"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="flow.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5943600" cy="5695950"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  $body+=(P $flowtext 'Caption')+(PageBreak)+(Heading 'Tools and their purposes')+(P 'This inventory describes tools referenced by the repository prompts. A prompt mention does not prove that a webhook is assigned, credentials are valid or a live integration is connected. Built-in availability also depends on agent settings and runtime configuration.')+(Table $tools)+(PageBreak)+(Heading 'Conversation rules and operating notes')
  foreach($r in $rules){$body+=(P $r)}
  $body+=(Heading 'Source files and scope')
  foreach($s in $sources){$body+=(P $s 'SourceText')}
  $body+=(P 'Prepared 16 October 2026 from the local repository. Production agent assignments and webhook execution history were not inspected. No credentials or private staff destinations are included.' 'SourceText')
  $body+='<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="900" w:right="1440" w:bottom="900" w:left="1440"/></w:sectPr>'
  $xml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'+$body+'</w:body></w:document>'
  [IO.File]::WriteAllText("$dir/word/document.xml",$xml)
  $styles='<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:color w:val="000000"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="130" w:line="270" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  foreach($s in @(@('Normal',22),@('Title',34),@('Subtitle',24),@('Heading1',26),@('TableText',21),@('Caption',19),@('SourceText',20))){$styles+='<w:style w:type="paragraph" w:styleId="'+$s[0]+'"><w:name w:val="'+$s[0]+'"/><w:pPr>'+$(if($s[0] -in @('Heading1','Title','Subtitle')){'<w:keepNext/>'})+'</w:pPr><w:rPr><w:sz w:val="'+$s[1]+'"/><w:color w:val="000000"/>'+$(if($s[0] -in @('Title','Heading1')){'<w:b/>'})+'</w:rPr></w:style>'}
  [IO.File]::WriteAllText("$dir/word/styles.xml",$styles+'</w:styles>')
  [IO.File]::WriteAllText("$dir/[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
  [IO.File]::WriteAllText("$dir/_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  [IO.File]::WriteAllText("$dir/word/_rels/document.xml.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/flow.png"/><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
  $target=Join-Path $out "$name.docx"
  if(Test-Path $target){Remove-Item -LiteralPath $target}
  [IO.Compression.ZipFile]::CreateFromDirectory($dir,$target)
}
$baseBoxes=@(
 @(25,15,550,100,"INBOUND`nGreet once and answer current need",'#E7F0F8'),
 @(625,15,550,100,"OUTBOUND`nState real purpose and ask to talk",'#E7F0F8'),
 @(325,165,550,95,"Understand intent and retain known details`nAnswer side questions then resume",'#E9F2EA')
)
$baseArrows=@(@(300,115,500,165),@(900,115,700,165),@(600,260,300,320),@(600,260,900,320))
Diagram 'Balaji' ($baseBoxes+@(
 @(25,320,550,115,"Information or rehabilitation enquiry`nKB facts and current Live Data prices",'#F1F4F7'),
 @(625,320,550,115,"Appointment agreed`nChoose consultation type once",'#F1F4F7'),
 @(625,485,255,150,"General Consultation`nMissing name and town`nNo date or time",'#E7F0F8'),
 @(920,485,255,150,"Teleconsultation`nName town date time`nSaturday 4 to 6 PM",'#E7F0F8'),
 @(625,685,255,130,"General Consultation tool`nVerified link sending`nCaller books and pays",'#E9F2EA'),
 @(920,685,255,130,"Teleconsultation tool`nVerified request saving`nStaff confirms date time",'#E9F2EA'),
 @(25,485,550,150,"Human help takes priority`nAnnouncement then transfer_call`nHold music while staff ring",'#FFF1D9'),
 @(25,685,550,130,"Staff answers then handoff`nWait mode failure resumes Anu`nCallback promise only after saved result",'#FFF1D9'),
 @(225,885,750,90,"Answer further help once then close`nSave summary through the configured logging process",'#E9F2EA'),
 @(225,1030,750,85,"Emergency overrides every branch`nImmediate local emergency care without waiting for transfer",'#FCE5E5')
)) ($baseArrows+@(@(750,435,750,485),@(1050,435,1050,485),@(750,635,750,685),@(1050,635,1050,685),@(300,435,300,485),@(300,635,300,685),@(300,815,450,885),@(750,815,650,885),@(1050,815,850,885)))
$balajiTools=@(
 @('Tool or capability','Purpose and conditions'),
 @('General Consultation','Prompt-named external action. Uses missing patient name and town plus the known caller number. Sends the approved WhatsApp booking link. Claim sent only after verified delivery/action success; a link is not a confirmed appointment.'),
 @('Teleconsultation','Prompt-named external action. Saves a request with patient name, town and preferred Saturday date/time between 4 and 6 PM. Staff confirms the appointment; tool success is not a booked slot.'),
 @('transfer_call','Built-in transfer to this agent company approved destination. Explicit human-help request is consent. Play announcement before handoff. Wait mode restores Anu on busy/rejected/no answer; direct mode has a failure message and ends.'),
 @('update_contact','Built-in caller-profile name update. Only a clearly stated caller-own name; never a patient or relative name. Replacement requires authorization and evidence. Confirm storage only on saved=true.'),
 @('manage_follow_up','Built-in automated Anu callback/reminder on the current caller number. Requires agreement; absolute schedules need proposal confirmation. This does not arrange a human staff callback.'),
 @('save_call_summary','Named in the prompts for one final call summary. Use an actually attached summary action or the configured runtime logging process. Do not invent a callable tool.'),
 @('Staff callback action','Optional configured action after failed transfer. No exact tool name is mandated by current prompts. Requires caller consent and verified saved=true plus requestId before promising a callback; notification is separately verified.')
)
MakeDoc 'Balaji' 'Balaji Robotic Rehab Hospital' 'Anu supports inbound enquiries and authorized outbound follow-up, explains rehabilitation services and collects consultation requests. This guide maps the current directional prompts, including native staff transfer.' 'Both entry points share the same enquiry, consultation and human-help branches. Refusal or goodbye closes the call; busy callers can agree to an automated Anu callback.' $balajiTools @(
 'Continuity and language. Speak natural Salem Tanglish in English letters unless English is requested. Keep known name, town, concern and consultation choice. Ask at most two missing intake fields per turn; answer interruptions and continue the next missing field without greeting again.',
 'General Consultation. The current prompts state Monday, Wednesday and Friday from 2 to 6 PM and Rs 350 consultation fee, with verified Live Data overriding prices. Collect only missing patient name and town. The caller finishes booking and payment through the verified WhatsApp link.',
 'Teleconsultation. Collect missing patient name, town, date and time. Saturday from 4 to 6 PM is the documented preference window. The hospital team confirms the fee and appointment. Do not describe the saved request as a confirmed booking.',
 'Human assistance. Team/staff requests override intake. After failed transfer, explain the actual result, retain the conversation and offer further help. No staff callback is automatic unless an agreed configured action succeeds. Emergency care must never wait for transfer.',
 'Connection status. Current prompt names are display labels; use the attached tool actual schema and identifier. The local documents cannot prove that General Consultation or Teleconsultation webhooks are assigned or operational in production.',
 'Source conflict to resolve. SHARED_KB.md still describes an older no-WhatsApp-booking flow and proposed transfer_to_ward/save_appointment_request tools. The current inbound and outbound prompts instead specify the booking-link flow and transfer_call. This guide follows the current directional prompts and records the conflict rather than treating legacy tools as connected.',
 'Price wording conflict. Fixed-facts text says never quote another General Consultation amount, while a later rule says verified Live Data overrides. Keep one unambiguous price authority when updating the prompts; current data must identify the correct service and currency.'
) @('docs/prompts/balaji robatic/INBOUND_PROMPT.md','docs/prompts/balaji robatic/OUTBOUND_PROMPT.md','docs/prompts/balaji robatic/SHARED_KB.md and LIVE_PRICES.xlsx (price workbook present; no live sync or row values certified here)','Backend/src/voice/tools/call-transfer-tool.js and docs/CALL_TRANSFER_SETTINGS.md (native transfer behavior)')
Diagram 'Shanmuga' ($baseBoxes+@(
 @(25,320,550,115,"Package or service information`nKB inclusions and current Live Data prices",'#F1F4F7'),
 @(625,320,550,115,"Booking requested`nCollect missing patient details and preference",'#F1F4F7'),
 @(625,485,550,105,"check_appointment_slots`nOffer only verified availability",'#E7F0F8'),
 @(625,640,550,105,"Caller agrees to selected slot`nbook_appointment with verified slot",'#E7F0F8'),
 @(625,795,550,125,"Verified booking then WhatsApp confirmation`nRelevant preparation and optional map`nFailure means recheck or staff help",'#E9F2EA'),
 @(25,485,550,105,"Brochure or map requested`nsend_whatsapp_brochure or location",'#E7F0F8'),
 @(25,640,550,105,"Clinical guidance or staff help`ntransfer_to_staff when configured",'#FFF1D9'),
 @(25,795,550,125,"Existing appointment`nmanage_appointment when configured`nOtherwise route to staff",'#FFF1D9'),
 @(225,965,750,70,"Answer further help once then close through runtime",'#E9F2EA'),
 @(225,1070,750,65,"Emergency symptoms override sales and booking",'#FCE5E5')
)) ($baseArrows+@(@(900,435,900,485),@(900,590,900,640),@(900,745,900,795),@(300,435,300,485),@(300,920,450,965),@(900,920,750,965)))
$shTools=@(
 @('Tool or capability','Purpose and conditions'),
 @('check_appointment_slots','External tool proposed in prompts. Read-only availability check for requested date/time. Clarify missing time or AM/PM and offer only returned slots. A check does not create a booking.'),
 @('book_appointment','External tool proposed in prompts. Book only after verified availability, required patient details and clear caller agreement. Use exact returned slot ID/time; avoid duplicate booking on failure.'),
 @('manage_appointment','External tool proposed in prompts. Cancel or reschedule an identified existing appointment after authorization. If unavailable, transfer to staff; callback cancellation is a separate action.'),
 @('send_whatsapp_brochure','External tool proposed in prompts. Send approved package details when requested or agreed. Announce, execute and continue; claim delivery only after verified success.'),
 @('send_whatsapp_location','External tool proposed in prompts. Send the approved hospital map/location when requested or agreed. Use configured recipient rules; do not invent a map URL.'),
 @('send_whatsapp_booking_confirmation','External tool proposed in prompts. Send verified booking details after booking succeeds under the agreed flow. Do not send a fabricated appointment confirmation.'),
 @('transfer_to_staff','External routing name in Shanmuga prompts. Staff help for clinical suitability, customization, insurance, refunds, complaints, doctor availability and unknown facts. Destination and implementation must be configured.'),
 @('update_contact','Existing built-in caller-own name update with ownership, exact quote evidence and replacement consent. A patient or relative name must not overwrite the caller profile.'),
 @('manage_follow_up','Existing built-in automated callback/reminder scheduling or cancellation on the caller number. Relative requests use backend time; absolute proposals need caller confirmation. Claim success only from verified flags.')
)
MakeDoc 'Shanmuga' 'Shanmuga Hospital' 'Karthika handles Master Health Check-up enquiries, approved package information, appointment requests and patient support. Inbound calls follow the caller need; outbound calls first establish the authorized purpose and willingness to talk.' 'WhatsApp, staff help and existing appointment requests are intent branches, not compulsory steps. Busy callers can agree to an automated callback; refusal ends outbound outreach without pressure.' $shTools @(
 'Continuity and language. Use everyday spoken Tamil in Tamil script with familiar English terms; switch to English when clearly preferred. Ask one question at a time. Retain known details, answer the current question and avoid repeated introductions or intake.',
 'Package discussion. Start with a short Silver, Gold and Platinum overview only when appropriate. Use the full KB catalogue for other packages. Explain inclusions from approved knowledge and prices/status from current Live Data. Do not quote pronunciation examples as current prices.',
 'Clinical concerns. Match the actual concern to documented packages or departments without diagnosis or prescribing a screening package for symptoms. Unclear suitability, medical advice and undocumented services go to configured staff assistance. Emergencies take priority over packages, callbacks and transfers.',
 'Booking sequence. Establish the actual patient, collect only missing required fields, check the preferred date/time, offer a verified slot and obtain booking agreement. Only verified book_appointment success allows confirmation. Then send the WhatsApp booking confirmation and appropriate preparation guidance.',
 'WhatsApp sequence. Announce the requested action and execute without redundant permission. Continue the conversation without waiting for a read receipt. Queued, sent and failed are different outcomes; use only supported recipient and content policies.',
 'Preparation and boundaries. KB guidance mentions 8 to 10 hours fasting and an 8 AM visit for relevant packages; these are not verified slots or universal instructions. Medication changes, individualized preparation and conflicting guidance require staff review.',
 'Connection status. SHARED_KB.md explicitly calls the external tool names proposed for configuration. They are not evidence of production connections. Verify all seven external actions in Agent Tools, including credentials, endpoints, recipient policies and booking schemas. Built-in update_contact and manage_follow_up also obey runtime authorization.',
 'Summary and ending. Use configured runtime call ending and logging. The Shanmuga directional prompts do not specify a separate save_call_summary tool. Do not add one to the connected-tool inventory without inspecting the actual agent settings.'
) @('docs/prompts/shannmuga hospital/INBOUND_PROMPT.md','docs/prompts/shannmuga hospital/OUTBOUND_PROMPT.md','docs/prompts/shannmuga hospital/SHARED_KB.md especially Operational tool roles','docs/prompts/shannmuga hospital/LIVE_PRICES.xlsx (present; workbook contents are not certified live prices)')
Write-Output 'Created Balaji.docx and Shanmuga.docx with matching Figma import SVG diagrams.'
