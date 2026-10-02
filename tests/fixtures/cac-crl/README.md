Throwaway certificates for `tests/server/cacRevocation.test.ts`: a test CA, a server certificate for localhost, a
card certificate that is valid and one that the CA has revoked, and the CA's CRL listing the revoked one. The keys
protect nothing; they exist only so the test can run a real TLS handshake. Valid until 2046.
