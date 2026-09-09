// Local stand-in for the DigiLocker consent screen, used only when
// IDENTITY_PROVIDER=mock. Visiting it flips the mock session created -> succeeded.
//
// This page exists so mock mode still exercises the real polling path. Mock mode
// must never short-circuit straight to succeeded, or bugs in the status loop go
// undetected until a live run.
// Spec: docs/architecture.md §4.7.1

export default function Page() {
  return null;
}
