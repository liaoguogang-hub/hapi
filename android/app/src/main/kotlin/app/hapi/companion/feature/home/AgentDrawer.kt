package app.hapi.companion.feature.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.AgentFilterUi
import app.hapi.companion.ui.components.AgentFlavorIcon

/**
 * Navigation drawer: one entry per agent that has sessions, plus a switch for
 * archived conversations.
 *
 * The drawer is the only place the agent filter lives, so the list screen keeps
 * its single top bar title and its two icons. Selecting an agent filters the
 * conversation list; "All agents" clears it.
 */
@Composable
internal fun AgentDrawer(
    agents: List<AgentFilterUi>,
    activeAgent: String?,
    showArchived: Boolean,
    onSelectAgent: (String?) -> Unit,
    onShowArchivedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    ModalDrawerSheet(modifier = modifier) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 20.dp)) {
            Text(
                text = stringResource(R.string.sessions_drawer_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text = stringResource(R.string.sessions_drawer_subtitle),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        HorizontalDivider()

        LazyColumn(Modifier.weight(1f)) {
            item {
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.sessions_agents_all)) },
                    selected = activeAgent == null,
                    onClick = { onSelectAgent(null) },
                    modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding),
                )
            }
            items(agents, key = { it.id }) { agent ->
                NavigationDrawerItem(
                    label = { Text(agent.label, maxLines = 1) },
                    badge = { Text(agent.sessionCount.toString(), style = MaterialTheme.typography.labelMedium) },
                    icon = { AgentFlavorIcon(flavor = agent.id) },
                    selected = activeAgent == agent.id,
                    onClick = { onSelectAgent(agent.id) },
                    modifier = Modifier.padding(NavigationDrawerItemDefaults.ItemPadding),
                )
            }
        }

        HorizontalDivider()

        Row(
            modifier = Modifier
                .fillMaxWidth()
                // A switch row: tapping anywhere toggles, not only the thumb.
                .selectable(
                    selected = showArchived,
                    role = Role.Switch,
                    onClick = { onShowArchivedChange(!showArchived) },
                )
                .padding(horizontal = 24.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.sessions_show_archived),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = stringResource(R.string.sessions_show_archived_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.width(12.dp))
            Switch(checked = showArchived, onCheckedChange = null)
        }
    }
}
