# Retired Render deployment

VDS is published through GitHub Releases and the NAS/FRP service. The old Render
service `srv-d6hkkfl6ubrc73btne50` is no longer a release target.

This checkout uses `.githooks/prepare-commit-msg` to append `[skip render]` to
commit messages automatically. Render documents this marker as skipping an
automatic deployment: <https://render.com/docs/deploys#skipping-an-auto-deploy>.
The hook keeps existing messages intact and avoids duplicate markers.

Activate it in another checkout with:

```sh
git config --local core.hooksPath .githooks
```

This is a checkout-level safeguard. It does not change Render's account-level
Auto-Deploy setting or revoke the Render GitHub App. Commits made from another
checkout or GitHub's website must also contain the marker to skip deployment.
The current GitHub CLI authorization cannot list the Render app installation;
its account-level setting has not been verified as disabled.
