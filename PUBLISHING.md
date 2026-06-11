# Publishing & Namespace Verification Guide

This guide explains how to publish the **Antigravity Panel** extension and resolve verification warnings (such as unverified publisher namespaces) on both the **Open VSX Registry** (used by VSCodium) and the **official VS Code Marketplace** (used by VS Code).

---

## 1. Open VSX Registry (VSCodium)

If you see a warning like:
> *“This version of the extension was published by nicola-palo. That user account is not a verified publisher of the namespace 'nicola-palo' of this extension...”*

This is because Open VSX organizes extensions into **namespaces** (e.g., the `nicola-palo` in `nicola-palo.antigravity-vscode-panel`). By default, anyone can create an account and publish, but the namespace itself must be officially claimed and verified to remove warnings.

### How to Fix It (Claim your Namespace)

1. **Log in to Open VSX:**
   - Go to [open-vsx.org](https://open-vsx.org/) and log in using your GitHub account (`nicola-palo`).
2. **Claim the Namespace:**
   - Navigate to your **User Settings** (click your profile image in the top-right corner) and select **Namespaces**.
   - Click **Add Namespace** and enter `nicola-palo`.
   - *Since your GitHub username is `nicola-palo`, Open VSX will automatically verify your ownership of this namespace.*
3. **Generate an Access Token:**
   - In your Open VSX User Settings, go to **Access Tokens**.
   - Create a new token and copy it.
4. **Publish Using the Token:**
   - When packaging and publishing your extension, use the `ovsx` CLI command:
     ```bash
     npx ovsx publish -t <YOUR_OPEN_VSX_TOKEN>
     ```
   - Once published using this token, the warning will disappear and the extension will be linked to your verified namespace.

---

## 2. Microsoft VS Code Marketplace

On the official VS Code Marketplace, a **Verified Publisher** badge (a blue checkmark next to the publisher name) indicates that the publisher has proven ownership of a domain associated with their identity.

### How to Get Verified

1. **Log in to the Management Portal:**
   - Go to the [VS Code Marketplace Publisher Management Portal](https://marketplace.visualstudio.com/manage).
2. **Select your Publisher:**
   - Choose the `nicola-palo` publisher.
3. **Add a Domain:**
   - Under publisher settings, add a website/domain that you own (e.g., `nicolapalo.dev`, or a domain associated with your GitHub pages).
4. **Verify Domain via DNS:**
   - The marketplace will generate a DNS TXT record (e.g., `vs-marketplace-verification-key=...`).
   - Add this TXT record to your domain's DNS configuration.
   - Click **Verify** in the Marketplace portal.
5. **Meet the Age Requirement:**
   - Note that to receive the blue verified checkmark, your publisher account must have been active on the Marketplace with at least one extension for **at least 6 months**.

---

## 3. General Best Practices for Publishing

> [!TIP]
> Before publishing, always ensure you bump the version number in `package.json` and generate a fresh package using:
> ```bash
> npx @vscode/vsce package
> ```

### Verification Checklist
- [ ] Publisher name in `package.json` matches your claimed namespace (`nicola-palo`).
- [ ] Remote repository URLs in `package.json` point to the correct GitHub repository (`https://github.com/nicola-palo/antigravityVSplug-in.git`).
- [ ] The version tag matches the git tag on your repository.
- [ ] You are publishing using valid access tokens generated from the verified publisher accounts.
