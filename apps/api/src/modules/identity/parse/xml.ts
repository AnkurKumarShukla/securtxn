// Shared XML access helpers.
//
// One parser is used for BOTH data extraction and signature verification. Using
// a different parser for each is a real vulnerability class: the verifier
// checks one interpretation of the bytes while the application reads another,
// and a crafted document can make the two disagree. @xmldom/xmldom is required
// by xml-crypto, so it is the one that verifies — therefore it is the one that
// reads.
//
// Spec: docs/architecture.md §4.7

import { DOMParser } from "@xmldom/xmldom";
import { UnprocessableError } from "../../../lib/errors.js";

export type XmlDocument = ReturnType<DOMParser["parseFromString"]>;
type XmlElement = ReturnType<XmlDocument["getElementsByTagName"]>[number];

export function parseXml(raw: string): XmlDocument {
  // The DOM parser reports recoverable problems through handlers rather than
  // throwing. A malformed signed document must not be treated as merely untidy.
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level === "error" || level === "fatalError") errors.push(message);
    },
  }).parseFromString(raw, "text/xml");

  if (errors.length > 0) {
    throw new UnprocessableError("Document is not well-formed XML", { errors: errors.slice(0, 3) });
  }
  return doc;
}

/**
 * First element with this local name, ignoring namespace prefix.
 *
 * DigiLocker documents are unprefixed while the signature is in the XMLDSig
 * namespace, so local-name matching keeps callers from caring which is which.
 */
export function firstElement(doc: XmlDocument | XmlElement, localName: string): XmlElement | null {
  const matches = doc.getElementsByTagName(localName);
  return matches.length > 0 ? (matches[0] ?? null) : null;
}

export function requireElement(
  doc: XmlDocument | XmlElement,
  localName: string,
  context: string,
): XmlElement {
  const element = firstElement(doc, localName);
  if (!element) {
    throw new UnprocessableError(`${context}: missing required <${localName}> element`);
  }
  return element;
}

/** Attribute value, or null when absent or empty. */
export function attr(element: XmlElement | null, name: string): string | null {
  if (!element) return null;
  const value = element.getAttribute(name);
  return value === null || value.trim() === "" ? null : value.trim();
}

export function requireAttr(element: XmlElement, name: string, context: string): string {
  const value = attr(element, name);
  if (value === null) {
    throw new UnprocessableError(`${context}: missing required @${name} attribute`);
  }
  return value;
}

export function textOf(element: XmlElement | null): string | null {
  if (!element) return null;
  const text = element.textContent?.trim() ?? "";
  return text === "" ? null : text;
}
