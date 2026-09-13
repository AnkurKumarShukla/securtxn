// Moved to components/ui/WorldIdStep.tsx.
//
// It lived here, but the payee page imported it across a route boundary
// (`../console/WorldIdStep`) — so /payee depended on /console's folder for a
// component neither route owns. It is shared UI, and it now lives with the
// rest of the shared UI.
//
// This re-export exists so nothing that already imports from this path breaks.

export { WorldIdStep } from "../../components/ui/WorldIdStep";
