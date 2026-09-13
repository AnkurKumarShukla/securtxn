"use client";

// App-wide state, held in the layout.
//
// WHY IT LIVES HERE. In the App Router a layout persists across navigations
// between its children, so anything mounted here survives moving from the
// payments list to the payee inbox. That matters for two things that must not
// restart: the agent token (re-minting on every page is a pointless round trip)
// and the payee's five-second poll (a payment arriving while you are on another
// screen still has to reach the badge in the sidebar).
//
// Everything is built after mount. A key or a stored value read during render
// differs between the server and the first client pass, and React throws the
// whole tree away on that mismatch.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, messageOf } from "../../lib/flow";
import { emptyAccount, isOnboarded, loadAccount, saveAccount, type Account } from "../../lib/account";
import type { Role } from "../../lib/account";
import { usePayeeFlow, type PayeeFlow } from "../../hooks/usePayeeFlow";

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_HEDERA_CHAIN_ID ?? "296");

type AppValue = {
  ready: boolean;
  /**
   * The one account, under its historical name.
   *
   * Paying and being paid are the same record now — one vendor, one wallet, one
   * verification. The key is still `org` because that is what a dozen screens
   * already read, and renaming it would churn every one of them to say the same
   * thing.
   */
  org: Account;
  setOrg: (patch: Partial<Account>) => void;
  /** Which half of the product is on screen. A view, not an identity. */
  role: Role;
  setRole: (role: Role) => void;
  /** Mints once and reuses. Ref-backed so its identity never changes. */
  token: () => Promise<string>;
  /** The last token minted, for reads that can tolerate not having one yet. */
  tokenValue: string | null;
  /**
   * A separate, approver-scoped token.
   *
   * The approval queue and settling are gated on this role, and an agent token
   * is refused outright. That separation IS the control — an agent may propose
   * a payment but may not release one — so the two are never conflated into a
   * single "the token".
   */
  approverToken: () => Promise<string>;
  payee: PayeeFlow;
  chainId: number;
  /** True once the paying organisation exists and has been verified. */
  orgReady: boolean;
};

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useApp must be used inside <AppProvider>");
  return value;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [org, setOrgState] = useState<Account>(emptyAccount);
  const [tokenValue, setTokenValue] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const approverRef = useRef<string | null>(null);

  useEffect(() => {
    setOrgState(loadAccount());
    setReady(true);
  }, []);

  const setOrg = useCallback((patch: Partial<Account>) => {
    setOrgState((prev) => {
      const next = { ...prev, ...patch };
      saveAccount(next);
      return next;
    });
  }, []);

  // The receiving half of the same account. It reads and writes the record
  // above rather than keeping one of its own, which is the whole point of the
  // unification: an onboarding done here is an onboarding done everywhere.
  const payee = usePayeeFlow(CHAIN_ID, ready ? org : null, setOrg);

  const setRole = useCallback((role: Role) => setOrg({ view: role }), [setOrg]);

  // Dependency-free ON PURPOSE: the payee's poll effect depends on a callback
  // like this, and an unstable identity would tear down and recreate the
  // five-second interval on every render.
  const token = useCallback(async (): Promise<string> => {
    if (tokenRef.current) return tokenRef.current;
    const res = await api("/dev/token", {
      method: "POST",
      body: { role: "agent", subject: "securtxn-web" },
    });
    if (!res.ok) throw new Error(`could not mint a token: ${messageOf(res.body)}`);
    tokenRef.current = (res.body as { token: string }).token;
    setTokenValue(tokenRef.current);
    return tokenRef.current;
  }, []);

  const approverToken = useCallback(async (): Promise<string> => {
    if (approverRef.current) return approverRef.current;
    const res = await api("/dev/token", {
      method: "POST",
      body: { role: "approver", subject: "securtxn-web" },
    });
    if (!res.ok) throw new Error(`could not mint an approver token: ${messageOf(res.body)}`);
    approverRef.current = (res.body as { token: string }).token;
    return approverRef.current;
  }, []);

  // Minted up front so the first list screen does not have to wait for it.
  useEffect(() => {
    if (!ready) return;
    void token().catch(() => {
      /* the screens surface their own failure; a dead API is not this hook's problem */
    });
  }, [ready, token]);

  const value = useMemo<AppValue>(
    () => ({
      ready,
      org,
      setOrg,
      role: org.view,
      setRole,
      token,
      tokenValue,
      approverToken,
      payee,
      chainId: CHAIN_ID,
      // Both directions need the same things, so there is one answer.
      orgReady: isOnboarded(org),
    }),
    [ready, org, setOrg, setRole, token, tokenValue, approverToken, payee],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
