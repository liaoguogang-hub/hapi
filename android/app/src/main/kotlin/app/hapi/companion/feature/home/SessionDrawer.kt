package app.hapi.companion.feature.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.AgentGroupUi
import app.hapi.companion.feature.sessions.ArchivedFilter
import app.hapi.companion.feature.sessions.SessionRowUi
import app.hapi.companion.feature.sessions.localizedRelativeAge
import app.hapi.companion.ui.components.AgentFlavorIcon

/** Rows shown per agent before the first "show more" tap. */
private const val DRAWER_PAGE = 5

/** Rows revealed by each subsequent tap. */
private const val DRAWER_PAGE_STEP = 5

/**
 * Drawer used as the conversation browser, following the DSH remote app: a
 * header with the connection, search plus view options on one row, then the
 * conversations.
 *
 * The one deliberate difference is grouping. DSH's host serves a single agent,
 * so its drawer groups by workspace; a Kestrel hub mixes several agents, so the
 * groups here are agents, each with its own collapsible section.
 */
@Composable
internal fun SessionDrawer(
    activeHubUrl: String,
    groups: List<AgentGroupUi>,
    archivedFilter: ArchivedFilter,
    searchQuery: String,
    onSearchQueryChange: (String) -> Unit,
    onArchivedFilterChange: (ArchivedFilter) -> Unit,
    onOpenSession: (String) -> Unit,
    onNewSession: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    var searchOpen by rememberSaveable { mutableStateOf(searchQuery.isNotEmpty()) }
    var viewMenuOpen by remember { mutableStateOf(false) }
    // Collapsed agent groups, remembered for the lifetime of the drawer.
    val collapsed = remember { mutableStateMapOf<String, Boolean>() }
    // Per-group "show more" counter; each tap reveals another page.
    val extraRows = remember { mutableStateMapOf<String, Int>() }
    // The search box keeps its own text. Binding it straight to the view-model
    // state made the caret jump to the start on the first keystroke: the field
    // committed the new text locally, then the round-tripped value arrived a
    // frame later and reset the selection.
    var queryDraft by remember { mutableStateOf(searchQuery) }
    val searchFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    // Opening the drawer search should put the caret in it, like the top bar's.
    LaunchedEffect(searchOpen) {
        if (searchOpen) {
            searchFocus.requestFocus()
            keyboard?.show()
        }
    }
    if (!searchOpen && queryDraft.isNotEmpty() && searchQuery.isEmpty()) {
        queryDraft = ""
    }

    ModalDrawerSheet(modifier = modifier.width(320.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, end = 6.dp, top = 12.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.sessions_drawer_app),
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = activeHubUrl,
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(
                onClick = {
                    searchOpen = !searchOpen
                    if (!searchOpen) onSearchQueryChange("")
                },
            ) {
                Icon(
                    if (searchOpen) Icons.Filled.Close else Icons.Filled.Search,
                    contentDescription = stringResource(
                        if (searchOpen) R.string.sessions_drawer_search_close else R.string.sessions_search_open,
                    ),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(19.dp),
                )
            }
            Box {
                IconButton(onClick = { viewMenuOpen = true }) {
                    Icon(
                        Icons.Filled.MoreVert,
                        contentDescription = stringResource(R.string.sessions_drawer_view_options),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(19.dp),
                    )
                }
                DropdownMenu(expanded = viewMenuOpen, onDismissRequest = { viewMenuOpen = false }) {
                    Text(
                        text = stringResource(R.string.sessions_drawer_archived_section),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                    ArchivedFilter.entries.forEach { option ->
                        DropdownMenuItem(
                            text = {
                                Text(
                                    text = stringResource(
                                        when (option) {
                                            ArchivedFilter.Hidden -> R.string.sessions_drawer_archived_hidden
                                            ArchivedFilter.All -> R.string.sessions_drawer_archived_all
                                            ArchivedFilter.Only -> R.string.sessions_drawer_archived_only
                                        },
                                    ),
                                    fontSize = 13.sp,
                                    color = if (archivedFilter == option) {
                                        MaterialTheme.colorScheme.primary
                                    } else {
                                        MaterialTheme.colorScheme.onSurface
                                    },
                                )
                            },
                            onClick = {
                                viewMenuOpen = false
                                onArchivedFilterChange(option)
                            },
                        )
                    }
                }
            }
            if (onNewSession != null) {
                IconButton(onClick = onNewSession) {
                    Icon(
                        Icons.Filled.Add,
                        contentDescription = stringResource(R.string.new_session_fab),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(21.dp),
                    )
                }
            }
        }

        if (searchOpen) {
            OutlinedTextField(
                value = queryDraft,
                onValueChange = { draft ->
                    queryDraft = draft
                    onSearchQueryChange(draft)
                },
                placeholder = { Text(stringResource(R.string.sessions_search_hint), fontSize = 12.sp) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp)
                    .focusRequester(searchFocus),
            )
        }

        Spacer(Modifier.height(6.dp))

        if (groups.isEmpty()) {
            Text(
                text = when {
                    searchQuery.isNotBlank() -> stringResource(R.string.sessions_drawer_no_match)
                    archivedFilter == ArchivedFilter.Only -> stringResource(R.string.sessions_drawer_empty_archived)
                    else -> stringResource(R.string.sessions_drawer_empty)
                },
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 18.dp, vertical = 14.dp),
            )
            return@ModalDrawerSheet
        }

        LazyColumn(Modifier.fillMaxSize()) {
            groups.forEach { group ->
                item(key = "group:${group.id}") {
                    val isCollapsed = collapsed[group.id] == true
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { collapsed[group.id] = !isCollapsed }
                            .padding(start = 14.dp, end = 10.dp, top = 12.dp, bottom = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AgentFlavorIcon(flavor = group.id, modifier = Modifier.size(15.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = group.label,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            text = group.sessions.size.toString(),
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                        )
                        Icon(
                            if (isCollapsed) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowUp,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
                if (collapsed[group.id] != true) {
                    val shown = group.sessions.take(DRAWER_PAGE + (extraRows[group.id] ?: 0))
                    items(shown, key = { "session:${it.id}" }) { row ->
                        DrawerSessionRow(row = row, onOpen = { onOpenSession(row.id) })
                    }
                    val hidden = group.sessions.size - shown.size
                    if (hidden > 0) {
                        item(key = "more:${group.id}") {
                            TextButton(
                                onClick = { extraRows[group.id] = (extraRows[group.id] ?: 0) + DRAWER_PAGE_STEP },
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                            ) {
                                Text(
                                    text = stringResource(R.string.sessions_drawer_show_more, hidden),
                                    fontSize = 12.sp,
                                )
                            }
                        }
                    } else if ((extraRows[group.id] ?: 0) > 0) {
                        item(key = "less:${group.id}") {
                            TextButton(
                                onClick = { extraRows[group.id] = 0 },
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                            ) {
                                Text(
                                    text = stringResource(R.string.sessions_drawer_show_less),
                                    fontSize = 12.sp,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DrawerSessionRow(row: SessionRowUi, onOpen: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 1.dp)
            .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
            .clickable(onClick = onOpen)
            .padding(start = 10.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = row.title,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f),
            )
            if (row.unread) {
                Spacer(Modifier.width(6.dp))
                Box(
                    Modifier
                        .size(6.dp)
                        .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(50)),
                )
            }
        }
        Spacer(Modifier.height(2.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                text = localizedRelativeAge(row.summary.updatedAt),
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )
            row.meta?.let { meta ->
                Text(
                    text = meta,
                    fontSize = 10.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                )
            }
        }
    }
}

/** Divider kept here so the drawer's sections stay visually separated. */
@Composable
internal fun DrawerSectionDivider() {
    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))
}
