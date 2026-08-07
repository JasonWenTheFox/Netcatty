import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const managerSource = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");
const layoutSource = readFileSync(
  new URL("../vault/VaultViewLayout.tsx", import.meta.url),
  "utf8",
);

test("note content drafts stay in refs so MDX keystrokes do not rebuild the shell", () => {
  assert.match(
    managerSource,
    /Content drafts stay in refs only/,
  );
  assert.doesNotMatch(
    managerSource,
    /const \[draftContent, setDraftContent\]/,
    "draftContent React state causes a full NotesManager render per keystroke",
  );
  assert.match(
    managerSource,
    /draftContentRef\.current = fields\.content;/,
  );
  assert.doesNotMatch(
    managerSource,
    /setDraftContent\(fields\.content\)/,
  );
});

test("NotesManager teardown flush uses a stable ref under StrictMode", () => {
  assert.match(managerSource, /flushNoteDraftRef\.current = flushNoteDraft/);
  assert.match(
    managerSource,
    /useEffect\(\(\) => \(\) => \{\s*\n\s*flushNoteDraftRef\.current\(\);\s*\n\s*\}, \[\]\)/,
  );
});

test("Vault notes section is memoized against unrelated VaultView churn", () => {
  assert.match(layoutSource, /const MemoVaultNotesSection = React\.memo\(VaultNotesSection\)/);
  assert.match(layoutSource, /<MemoVaultNotesSection\b/);
  assert.match(layoutSource, /const handleNotesOpenHost = useCallback/);
  assert.match(layoutSource, /onOpenHost=\{handleNotesOpenHost\}/);
});
