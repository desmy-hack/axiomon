-- À exécuter une seule fois dans Supabase (SQL Editor) si tu préfères ne pas laisser le serveur migrer au démarrage.
-- Sans danger si relancé : tout est « IF NOT EXISTS ».
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS frozen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS locked_until BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS note TEXT;
CREATE TABLE IF NOT EXISTS public.audit (
  id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS public.settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Supabase expose ces tables via son API REST : on active la sécurité par lignes sans politique,
-- ce qui les rend inaccessibles depuis la clé publique (le serveur Express, lui, se connecte directement).
ALTER TABLE public.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
