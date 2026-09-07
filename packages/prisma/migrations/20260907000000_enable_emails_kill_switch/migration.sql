-- Lavela deployment sends no email of its own: the platform owns all patient and
-- therapist communication, so booking mail from this instance would be duplicate
-- and off-brand.
--
-- 'emails' is a KILL_SWITCH flag seeded by 20230303195432_add_feature_flag_default_values
-- with enabled = false. Its polarity is inverted relative to the other flags:
-- enabled = true means "prevent any emails being sent". BaseEmail.sendEmail()
-- checks it before constructing a transport, so no SMTP configuration is needed.
--
-- Toggle it back from the admin feature-flags UI if email is ever wanted; this
-- migration only sets the starting state.
UPDATE "Feature"
SET "enabled" = true,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'emails';

-- Defensive: create the row if an older database predates the seed migration.
INSERT INTO "Feature" ("slug", "enabled", "description", "type", "createdAt", "updatedAt")
VALUES (
  'emails',
  true,
  'Enable to prevent any emails being send',
  'KILL_SWITCH',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO NOTHING;
