/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // No PII may reach the client bundle. Only NEXT_PUBLIC_* is exposed, and the
  // only public value this app needs is the World App id (§4.6).
};
