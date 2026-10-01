CREATE VIRTUAL TABLE `memories_fts` USING fts5(id UNINDEXED, content, tags);
