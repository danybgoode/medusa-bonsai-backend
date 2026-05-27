import { defineWidgetConfig } from '@medusajs/admin-sdk'
import { useQuery } from '@tanstack/react-query'
import { Container, Heading, Text, Badge, Button } from '@medusajs/ui'
import { BuildingStorefront } from '@medusajs/icons'

type Seller = {
  id: string
  name: string
  slug: string
  location: string | null
  verified: boolean
  claimed: boolean
  product_count: number
}

export const config = defineWidgetConfig({
  zone: 'product.details.before',
})

export default function ProductSellerWidget({ data }: { data: { id: string } }) {
  const { data: result, isLoading } = useQuery<{ seller: Seller | null }>({
    queryKey: ['admin', 'product-seller', data.id],
    queryFn: () =>
      fetch(`/admin/sellers?product_id=${data.id}`).then(r => r.json()),
  })

  const seller = result?.seller

  if (isLoading) {
    return (
      <Container className="mb-4 p-4">
        <Text size="small" className="text-ui-fg-subtle">Loading seller info…</Text>
      </Container>
    )
  }

  if (!seller) {
    return (
      <Container className="mb-4 p-4">
        <div className="flex items-center gap-2">
          <BuildingStorefront className="text-ui-fg-subtle" />
          <Text size="small" className="text-ui-fg-subtle">
            No seller linked to this product.
          </Text>
        </div>
      </Container>
    )
  }

  return (
    <Container className="mb-4 p-4">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <BuildingStorefront className="text-ui-fg-base" />
            <Heading level="h3">{seller.name}</Heading>
            {seller.verified && <Badge color="green" size="xsmall">Verified</Badge>}
            {!seller.claimed && <Badge color="orange" size="xsmall">Unclaimed</Badge>}
          </div>
          <Text size="small" className="text-ui-fg-subtle font-mono">
            /s/{seller.slug}
          </Text>
          {seller.location && (
            <Text size="small" className="text-ui-fg-subtle">
              {seller.location}
            </Text>
          )}
          <Text size="xsmall" className="text-ui-fg-muted">
            {seller.product_count} listing{seller.product_count !== 1 ? 's' : ''} total
          </Text>
        </div>
        <div className="flex gap-2">
          <Button
            size="small"
            variant="secondary"
            onClick={() =>
              window.open(`https://miyagisanchez.com/s/${seller.slug}`, '_blank')
            }
          >
            View storefront
          </Button>
        </div>
      </div>
    </Container>
  )
}
