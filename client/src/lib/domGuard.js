// Survive third-party DOM mutation (React "removeChild NotFoundError").
//
// Safari/Chrome auto-translate and some browser extensions rewrite text nodes —
// they replace them with <font> wrappers or swap them out. When React later runs
// its commit phase and calls removeChild / insertBefore on a node that the
// translator already moved, the browser throws NotFoundError ("The node to be
// removed is not a child of this node" / "The object can not be found here") and
// the WHOLE app crashes into the error boundary.
//
// This is a long-standing, well-known React interaction (facebook/react#11538).
// The accepted mitigation: make these two Node methods no-op safely when the node
// isn't actually a child of the target, instead of throwing. It only changes
// behaviour in the exact error case, so normal rendering is untouched — but a
// translated page no longer takes the app down.
export function installDomGuard() {
  if (typeof Node !== 'function' || !Node.prototype) return;
  if (Node.prototype.__howlerDomGuard) return; // idempotent
  Node.prototype.__howlerDomGuard = true;

  const realRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function removeChild(child) {
    if (child && child.parentNode !== this) {
      if (child.parentNode) return child.parentNode.removeChild(child); // remove from its ACTUAL parent
      return child; // already detached — nothing to do
    }
    return realRemoveChild.call(this, child);
  };

  const realInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function insertBefore(newNode, referenceNode) {
    if (referenceNode && referenceNode.parentNode !== this) {
      return realInsertBefore.call(this, newNode, null); // append instead of throwing
    }
    return realInsertBefore.call(this, newNode, referenceNode);
  };
}
