# Agent recovery configuration

Set **Neutral Recovery Message** in this agent's UI settings to:

மன்னிக்கவும், உங்கள் கோரிக்கைக்கு சரியான பதிலைத் தயார் செய்ய முடியவில்லை. கொஞ்சம் வேறு விதமாகச் சொல்ல முடியுமா?

Configuration key: `settings.nonFactualRecoveryMessage`.

This is agent configuration, not a knowledge-base upload or a system-prompt instruction. Saving this file does not update the live agent. Save the value in the UI before deploying the profile-readiness check: agents without approved usable recovery wording cannot load a new call profile. Existing healthy calls are not terminated by this check.

Dedicated answer-validation and workflow-configuration recovery messages, if configured, take precedence. Ensure those are approved too. Do not use wording that asserts a provider outage, missing published information, or booking success as neutral recovery.
