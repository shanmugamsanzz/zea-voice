# Generic Catalog hierarchy format

Catalog hierarchy is tenant-provided. Runtime code does not define industries, category names, item names or selection policies.

```text
CATEGORY: Service Plans | KEY=service-plans | PARENT=all-offerings | ALIASES=Plans, Options | DESCRIPTION=Available service tiers | DEFAULT_SELECTION={"strategy":"clarify","defaultItemKey":"standard-plan"}
Standard Plan INR 100 | KEY=standard-plan | ALIASES=Standard, Basic | DESCRIPTION=Standard approved service | RELATIONSHIPS={"alternatives":["premium-plan"]} | SELECTION_RULES={"allowedIntents":["details","select"]}
Premium Plan INR 200 | KEY=premium-plan | ALIASES=Premium, Advanced | DESCRIPTION=Premium approved service | RELATIONSHIPS={"alternatives":["standard-plan"]}
```

## Category directives

- `CATEGORY`: Required category display name.
- `KEY`: Optional stable category key. A normalized key is generated when omitted.
- `PARENT`: Optional stable parent-category key.
- `ALIASES`: Optional comma-separated spoken names.
- `DESCRIPTION`: Optional approved category description.
- `DEFAULT_SELECTION`: Optional JSON object defining tenant selection behaviour.
- `DEFAULT_ITEM`: Optional shorthand that sets `defaultItemKey` in the category selection rules.

## Item directives

- `KEY` or `ITEM_KEY`: Optional stable item key. A normalized key is generated when omitted.
- `CATEGORY` and `CATEGORY_KEY`: Optional inline category override.
- `ALIASES`: Optional comma-separated spoken names and common STT forms.
- `DESCRIPTION`: Optional approved item description.
- `RELATIONSHIPS`: Optional JSON object containing tenant-defined links such as alternatives, add-ons, prerequisites or related items.
- `SELECTION_RULES`: Optional JSON object controlling when the item may be selected.

JSON directives must contain objects. Invalid JSON is reported as an extraction warning and is not applied.
