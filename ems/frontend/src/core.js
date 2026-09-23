/* Dependency seam — the single place that pulls in Preact + HTM. Every other
   module imports its framework primitives from here (replaces the old vendored
   UMD bundle + window.App globals). */
import { h, render, Fragment } from 'preact';
import {
  useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect,
} from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

export {
  h, render, Fragment,
  useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect,
};
