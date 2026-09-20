# PaperCanvas

PaperCanvas is a local-first workspace for reading papers, arranging them spatially, and discussing them in embedded ChatGPT while the source PDF remains in view.

## Language

**Paper**:
A PDF-backed library item that can appear as one card on the whiteboard and can belong to at most one domain.
_Avoid_: Document, file, article

**Domain**:
A user-defined subject partition containing zero or more papers. Deleting a domain never deletes its papers.
_Avoid_: Folder, category, collection, area

**Unclassified**:
The virtual partition for papers that do not belong to a domain; it is not a stored domain and cannot be deleted.
_Avoid_: Default domain, inbox, uncategorized

**Domain view**:
A whiteboard projection that shows only papers belonging to one domain while preserving their positions in the shared whiteboard layout.
_Avoid_: Separate board, workspace

**All view**:
The whiteboard projection that shows every paper and visually encloses papers from the same domain with a dashed boundary. It is not a stored domain.
_Avoid_: Global domain, root domain

**Discussion**:
A paper-bound ChatGPT conversation link whose name and URL are stored locally. Its messages remain on ChatGPT. The full discussion surface belongs in the PDF reader; the main workspace presents recent discussion links.
_Avoid_: Chat thread, prompt history
