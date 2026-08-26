# Authentication and Authorization

This package owns deployment-boundary request authentication, exact-origin checks, cookie-mode CSRF validation, and role authorization. It has no persistence or application-domain authority.

Local mode attributes requests to an explicit local operator. Remote mode accepts configured opaque bearer or cookie credentials and fails closed at configuration parsing when authentication or transport controls are incomplete.
