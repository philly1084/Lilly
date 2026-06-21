(function hydrateKimiBuiltFrontend() {
    var fullUrl = window.KimiBuiltFrontendFullUrl || '';
    if (!fullUrl) {
        return;
    }

    function absoluteUrl(value) {
        try {
            return new URL(value, fullUrl).href;
        } catch (_error) {
            return value;
        }
    }

    function copyAttributes(source, target) {
        Array.prototype.forEach.call(source.attributes || [], function (attribute) {
            target.setAttribute(attribute.name, attribute.value);
        });
    }

    function loadScript(sourceScript) {
        return new Promise(function (resolve) {
            var script = document.createElement('script');
            copyAttributes(sourceScript, script);
            script.async = false;
            script.onload = resolve;
            script.onerror = resolve;
            if (sourceScript.src) {
                script.src = absoluteUrl(sourceScript.getAttribute('src') || sourceScript.src);
            } else {
                script.textContent = sourceScript.textContent || '';
            }
            document.body.appendChild(script);
            if (!sourceScript.src) {
                resolve();
            }
        });
    }

    async function hydrateDocument(html) {
        var parser = new DOMParser();
        var parsed = parser.parseFromString(html, 'text/html');
        var scripts = Array.prototype.slice.call(parsed.querySelectorAll('script'));
        scripts.forEach(function (script) {
            script.remove();
        });

        document.documentElement.getAttributeNames().forEach(function (name) {
            document.documentElement.removeAttribute(name);
        });
        copyAttributes(parsed.documentElement, document.documentElement);
        document.title = parsed.title || document.title;
        document.head.replaceChildren.apply(document.head, Array.prototype.slice.call(parsed.head.childNodes).map(function (node) {
            return document.importNode(node, true);
        }));
        copyAttributes(parsed.body, document.body);
        document.body.replaceChildren.apply(document.body, Array.prototype.slice.call(parsed.body.childNodes).map(function (node) {
            return document.importNode(node, true);
        }));

        for (var index = 0; index < scripts.length; index += 1) {
            await loadScript(scripts[index]);
        }

        document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
        window.dispatchEvent(new Event('DOMContentLoaded'));
        window.dispatchEvent(new Event('load'));
        if (typeof window.KimiBuiltReleaseCriticalShell === 'function') {
            window.KimiBuiltReleaseCriticalShell();
        } else {
            document.body.classList.remove('kb-critical-loading');
            document.body.classList.add('kb-critical-loaded');
        }
    }

    fetch(fullUrl, { credentials: 'same-origin', cache: 'no-store' })
        .then(function (response) {
            if (!response.ok) {
                throw new Error('Frontend load failed: ' + response.status);
            }
            return response.text();
        })
        .then(hydrateDocument)
        .catch(function () {
            window.location.replace(fullUrl);
        });
}());
