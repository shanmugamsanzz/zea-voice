# Booking configuration check

The call log reported `missing_schema_property` for:

- `patient_name`
- `patient_age`
- `selected_package`
- `appointment_date`
- `appointment_time`
- `booking_for`

In the agent UI, inspect the tool actually selected by the published workflow's tool identifier. Its **Input schema** (`configuration.inputSchema`) must define the intended properties under `properties`, with the API's real types and validation rules. Put mandatory API fields in `required`.

Compare each Information Field's exact key, question, required flag and Required Action assignment with that schema. Explicitly tool-assigned fields must exist in the schema. Schema-required fields must have configured questions. Optional unassigned fields belonging to other tools need not be added. Resolve duplicate keys rather than relying on their order.

Keep the configured confirmation message and execution authorization. Do not infer API types, dates/formats or allowed values from these field names. If the API does not accept a field, correct the field assignment instead of adding a fictitious property.

This checklist does not modify the live agent. The effective database configuration and selected tool still need UI verification. The runtime accepts existing legacy schema keys consistently, but new UI writes use `inputSchema`.
