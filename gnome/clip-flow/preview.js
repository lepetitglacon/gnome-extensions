/**
 * Fabrication des aperçus, partagée par le panneau et la barre supérieure.
 *
 * Tout est tronqué avant d'atteindre Pango : l'historique accepte des entrées
 * de plusieurs mégaoctets, et rien n'oblige à les mettre en page pour en
 * afficher trois lignes.
 */

const MAX_CHARS_PER_LINE = 200;

export function sizeLabel(entry) {
    return `${Math.max(1, Math.round((entry.size ?? 0) / 1024))} ko`;
}

/** Une ligne unique, sauts de ligne rendus visibles : pour la barre supérieure. */
export function previewFor(entry, limit) {
    if (!entry)
        return '';

    if (entry.type === 'image')
        return `Image ${sizeLabel(entry)}`;

    const text = usefulLines(entry.text, 3).join(' ⏎ ').replace(/\s+/g, ' ');
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Jusqu'à `count` lignes réelles, comme le panneau de Windows.
 *
 * Chaque ligne est rendue séparément par l'appelant : c'est le seul moyen
 * d'obtenir des points de suspension fiables en fin de ligne, St ne sachant
 * pas tronquer un paragraphe replié sur une hauteur donnée.
 */
export function previewLines(entry, count) {
    if (entry.type === 'image')
        return [`Image ${sizeLabel(entry)}`];

    const lines = usefulLines(entry.text, count);
    return lines.length > 0 ? lines : [''];
}

function usefulLines(text, count) {
    const lines = [];

    // On ne parcourt pas tout : `split` sur plusieurs mégaoctets pour trois
    // lignes serait du gaspillage pur.
    for (const line of text.slice(0, count * MAX_CHARS_PER_LINE * 4).split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;

        lines.push(trimmed.length > MAX_CHARS_PER_LINE
            ? `${trimmed.slice(0, MAX_CHARS_PER_LINE)}…`
            : trimmed);

        if (lines.length === count)
            break;
    }

    return lines;
}
