import { defineRouteConfig } from '@medusajs/admin-sdk'
import { BuildingStorefront } from '@medusajs/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Container, Heading, Text, Badge, Button, Table,
  IconButton, Tooltip, Input,
} from '@medusajs/ui'
import { CheckCircle, XCircle, MagnifyingGlass, ArrowUpRightOnBox } from '@medusajs/icons'
import { useState } from 'react'

export const config = defineRouteConfig({
  label: 'Sellers',
  icon: BuildingStorefront,
})

type Seller = {
  id: string
  name: string
  slug: string
  description: string | null
  location: string | null
  verified: boolean
  claimed: boolean
  clerk_user_id: string | null
  product_count: number
  source: string | null
  created_at: string
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified
    ? <Badge color="green" size="xsmall">Verified</Badge>
    : <Badge color="grey" size="xsmall">Unverified</Badge>
}

function ClaimedBadge({ claimed }: { claimed: boolean }) {
  return claimed
    ? <Badge color="blue" size="xsmall">Claimed</Badge>
    : <Badge color="orange" size="xsmall">Unclaimed</Badge>
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return null
  const color = source === 'registered' ? 'purple' : source === 'claimed' ? 'blue' : 'grey'
  return <Badge color={color as any} size="xsmall">{source}</Badge>
}

export default function SellersPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')

  const { data, isLoading } = useQuery<{ sellers: Seller[]; count: number }>({
    queryKey: ['admin', 'sellers'],
    queryFn: () => fetch('/admin/sellers').then(r => r.json()),
  })

  const verifyMutation = useMutation({
    mutationFn: ({ id, verified }: { id: string; verified: boolean }) =>
      fetch(`/admin/sellers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verified }),
      }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'sellers'] }),
  })

  const sellers = (data?.sellers ?? []).filter(s =>
    !search ||
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.slug.toLowerCase().includes(search.toLowerCase()) ||
    (s.location ?? '').toLowerCase().includes(search.toLowerCase())
  )

  const stats = {
    total: data?.count ?? 0,
    verified: (data?.sellers ?? []).filter(s => s.verified).length,
    claimed: (data?.sellers ?? []).filter(s => s.claimed).length,
    products: (data?.sellers ?? []).reduce((sum, s) => sum + s.product_count, 0),
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Heading level="h1">Sellers</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            All registered merchants on miyagisanchez.com
          </Text>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total sellers', value: stats.total },
          { label: 'Verified', value: stats.verified },
          { label: 'Claimed', value: stats.claimed },
          { label: 'Total listings', value: stats.products },
        ].map(stat => (
          <Container key={stat.label} className="p-4">
            <Text size="small" className="text-ui-fg-subtle">{stat.label}</Text>
            <Heading level="h2">{stat.value}</Heading>
          </Container>
        ))}
      </div>

      {/* Table */}
      <Container>
        <div className="flex items-center gap-2 p-4 border-b border-ui-border-base">
          <MagnifyingGlass className="text-ui-fg-subtle" />
          <Input
            placeholder="Search by name, slug, or location…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border-0 shadow-none focus:ring-0 text-sm"
          />
        </div>

        {isLoading ? (
          <div className="p-8 text-center">
            <Text className="text-ui-fg-subtle">Loading sellers…</Text>
          </div>
        ) : sellers.length === 0 ? (
          <div className="p-8 text-center">
            <Text className="text-ui-fg-subtle">
              {search ? 'No sellers match your search.' : 'No sellers registered yet.'}
            </Text>
          </div>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Shop</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell>Location</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Listings</Table.HeaderCell>
                <Table.HeaderCell>Joined</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Actions</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {sellers.map(seller => (
                <Table.Row key={seller.id}>
                  <Table.Cell>
                    <div className="flex flex-col gap-0.5">
                      <Text weight="plus" size="small">{seller.name}</Text>
                      <Text size="xsmall" className="text-ui-fg-subtle font-mono">
                        /{seller.slug}
                      </Text>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap gap-1">
                      <VerifiedBadge verified={seller.verified} />
                      <ClaimedBadge claimed={seller.claimed} />
                      <SourceBadge source={seller.source} />
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small" className="text-ui-fg-subtle">
                      {seller.location ?? '—'}
                    </Text>
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    <Text size="small" weight="plus">{seller.product_count}</Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small" className="text-ui-fg-subtle">
                      {new Date(seller.created_at).toLocaleDateString('es-MX', {
                        day: 'numeric', month: 'short', year: 'numeric',
                      })}
                    </Text>
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Tooltip
                        content={seller.verified ? 'Remove verification' : 'Verify seller'}
                      >
                        <IconButton
                          size="small"
                          variant="transparent"
                          onClick={() => verifyMutation.mutate({
                            id: seller.id,
                            verified: !seller.verified,
                          })}
                          disabled={verifyMutation.isPending}
                        >
                          {seller.verified
                            ? <XCircle className="text-ui-fg-subtle" />
                            : <CheckCircle className="text-ui-tag-green-icon" />
                          }
                        </IconButton>
                      </Tooltip>
                      <Tooltip content="Open storefront">
                        <IconButton
                          size="small"
                          variant="transparent"
                          onClick={() => window.open(
                            `https://miyagisanchez.com/s/${seller.slug}`, '_blank'
                          )}
                        >
                          <ArrowUpRightOnBox className="text-ui-fg-subtle" />
                        </IconButton>
                      </Tooltip>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Container>
    </div>
  )
}
